// scripts/index_knowledge_pinecone.mjs
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { Pinecone } from "@pinecone-database/pinecone";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fichiers source
const KB_DIR = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");

// Split
const CHUNK_SIZE    = Number(process.env.CHUNK_SIZE || 800);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 150);

// Pinecone
const PC_API_KEY   = process.env.PINECONE_API_KEY || "";
const PC_INDEX     = process.env.PINECONE_INDEX || "";
const PC_NAMESPACE = process.env.PINECONE_NAMESPACE || undefined;
const PC_CLOUD     = process.env.PINECONE_CLOUD || "aws";
const PC_REGION    = process.env.PINECONE_REGION || "us-east-1";
const BATCH_SIZE   = Number(process.env.PINECONE_BATCH_SIZE || 100);

// Extensions acceptées
const ALLOWED = new Set([".md", ".txt", ".log", ".sh", ".conf", ".cfg", ".ini", ".yaml", ".yml"]);

function assertEnv() {
  const missing = [];
  if (!process.env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!PC_API_KEY) missing.push("PINECONE_API_KEY");
  if (!PC_INDEX) missing.push("PINECONE_INDEX");
  if (missing.length) {
    console.error("❌ Variables manquantes:", missing.join(", "));
    process.exit(1);
  }
}

async function walk(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const acc = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) acc.push(...await walk(full));
    else if (ALLOWED.has(path.extname(e.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

function hashId(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

async function ensureIndex(client, dimension) {
  const existing = await client.listIndexes();
  const names = (existing?.indexes || existing || []).map((i) => (i.name ? i.name : i));
  if (!names.includes(PC_INDEX)) {
    console.log(`🆕 Création index '${PC_INDEX}' (dim=${dimension}, metric=cosine, ${PC_CLOUD}/${PC_REGION})…`);
    await client.createIndex({
      name: PC_INDEX,
      dimension,
      metric: "cosine",
      spec: { serverless: { cloud: PC_CLOUD, region: PC_REGION } },
    });
    // petit délai de provisionnement
    console.log("⏳ Attente 30s pour la disponibilité de l’index…");
    await new Promise((r) => setTimeout(r, 30000));
  } else {
    console.log(`✅ Index '${PC_INDEX}' déjà présent`);
  }
}

async function main() {
  assertEnv();

  if (!fs.existsSync(KB_DIR)) {
    console.error("❌ knowledge_base introuvable :", KB_DIR);
    process.exit(1);
  }

  console.log("📚 Lecture depuis :", KB_DIR);
  const files = await walk(KB_DIR);
  if (!files.length) {
    console.warn("⚠️ Aucun fichier pris en compte.");
    process.exit(0);
  }

  // Charge les documents bruts
  const rawDocs = await Promise.all(
    files.map(async (p) => ({
      text: await fs.promises.readFile(p, "utf8"),
      metadata: { source: path.basename(p), fullPath: p },
    }))
  );

  // Split en chunks
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const docs = [];
  for (const d of rawDocs) {
    const parts = await splitter.splitText(d.text);
    parts.forEach((t, i) =>
      docs.push({ text: t, metadata: { ...d.metadata, chunk: i } })
    );
  }
  console.log(`✂️  Chunks: ${docs.length} (chunkSize=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`);

  // Embeddings (Gemini)
  const embedder = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    model: "text-embedding-004",
  });

  console.log("🧮 Génération des embeddings…");
  const vectors = await embedder.embedDocuments(docs.map((d) => d.text));
  const dim = vectors[0]?.length || 0;
  if (!dim) {
    console.error("❌ Embeddings vides (clé GEMINI/API ?)");
    process.exit(1);
  }
  console.log(`✅ Embeddings ok (dim=${dim})`);

  // Pinecone client
  const client = new Pinecone({ apiKey: PC_API_KEY });
  await ensureIndex(client, dim);
  const index = client.index(PC_INDEX);

  // Upsert en batch
  console.log(`⬆️  Upsert vers Pinecone (batch=${BATCH_SIZE}, namespace=${PC_NAMESPACE || "-"})…`);
  let upserted = 0;

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const slice = vectors.slice(i, i + BATCH_SIZE);
    const items = slice.map((values, j) => {
      const d = docs[i + j];
      // Construit un id stable
      const id = hashId(`${d.metadata.source}:${d.metadata.chunk}:${values.length}:${d.text.length}`);
      // Réduit le texte en metadata pour rester raisonnable (<~1–2KB)
      const preview = d.text.slice(0, 1000);
      return {
        id,
        values,
        metadata: {
          source: d.metadata.source,
          chunk: d.metadata.chunk,
          fullPath: d.metadata.fullPath,
          text: preview,
        },
      };
    });

    await index.upsert({
      vectors: items,
      ...(PC_NAMESPACE ? { namespace: PC_NAMESPACE } : {}),
    });

    upserted += items.length;
    process.stdout.write(`  • ${upserted}/${vectors.length}\r`);
  }
  process.stdout.write("\n");

  console.log("🎉 Indexation Pinecone terminée.");
  console.log(`   Index: ${PC_INDEX}`);
  if (PC_NAMESPACE) console.log(`   Namespace: ${PC_NAMESPACE}`);
  console.log(`   Dim: ${dim}, Vecteurs: ${vectors.length}`);
}

main().catch((e) => {
  console.error("💥 Échec indexation Pinecone:", e);
  process.exit(1);
});
