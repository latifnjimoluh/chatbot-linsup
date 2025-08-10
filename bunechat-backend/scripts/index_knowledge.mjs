import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dossiers / fichiers
const KB_DIR   = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");
const OUT_DIR  = path.resolve(__dirname, "..", process.env.VECTOR_DIR || "vectorstore");
const OUT_FILE = path.join(OUT_DIR, "index.json");

// Split & Embeddings
const CHUNK_SIZE     = Number(process.env.CHUNK_SIZE || 800);
const CHUNK_OVERLAP  = Number(process.env.CHUNK_OVERLAP || 150);
const MAX_CHARS_PER_CHUNK = Number(process.env.MAX_CHARS_PER_CHUNK || 8000); // garde-fou
const EMBED_BATCH    = Math.max(1, Number(process.env.EMBED_BATCH || 128));
const INCREMENTAL    = String(process.env.INCREMENTAL || "1") !== "0"; // 1 par défaut

// Extensions acceptées
const ALLOWED = new Set([".md", ".txt", ".log", ".sh", ".conf", ".cfg", ".ini", ".yaml", ".yml"]);

// Utils
const t0 = Date.now();
const since = () => Math.round(Date.now() - t0) + "ms";
const human = (n) => n.toLocaleString("fr-FR");

function hashStr(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}
function normLF(s) {
  return String(s || "").replace(/\r\n/g, "\n");
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
function assertEnv() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY manquant dans .env");
    process.exit(1);
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

  // Charge index existant (pour incrémental)
  let prev = null;
  if (INCREMENTAL && fs.existsSync(OUT_FILE)) {
    try { prev = JSON.parse(await fs.promises.readFile(OUT_FILE, "utf8")); }
    catch { prev = null; }
  }
  const prevMap = new Map(); // clé -> vecteur
  if (prev?.vectors?.length && prev?.docs?.length === prev.vectors.length) {
    // Clé d’unicité = fullPath + chunk + hash(text)
    for (let i = 0; i < prev.docs.length; i++) {
      const d = prev.docs[i];
      const key = `${d?.metadata?.fullPath}#${d?.metadata?.chunk}#${hashStr(d?.text || "")}`;
      prevMap.set(key, prev.vectors[i]);
    }
    console.log(`♻️  Index précédent détecté : réutilisation potentielle sur ${human(prevMap.size)} chunks.`);
  }

  // Lecture brute
  const rawDocs = await Promise.all(
    files.map(async (p) => {
      const text = normLF(await fs.promises.readFile(p, "utf8"));
      return {
        text,
        metadata: { source: path.basename(p), fullPath: p },
        size: Buffer.byteLength(text, "utf8"),
      };
    })
  );

  // Split
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const docs = [];
  let ignoredOversize = 0;

  for (const d of rawDocs) {
    const parts = await splitter.splitText(d.text);
    parts.forEach((t, i) => {
      let text = normLF(t).trim();
      if (!text) return;
      if (text.length > MAX_CHARS_PER_CHUNK) {
        text = text.slice(0, MAX_CHARS_PER_CHUNK);
        ignoredOversize++;
      }
      docs.push({ text, metadata: { ...d.metadata, chunk: i } });
    });
  }
  console.log(`✂️  Chunks: ${human(docs.length)} (chunkSize=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`);
  if (ignoredOversize) console.log(`⚠️ ${ignoredOversize} chunk(s) tronqué(s) à ${MAX_CHARS_PER_CHUNK} caractères.`);

  // Embeddings (Gemini)
  const embedder = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    model: "text-embedding-004",
  });

  console.log("🧮 Génération des embeddings… (batch =", EMBED_BATCH, ")");
  const vectors = new Array(docs.length);
  let reused = 0, computed = 0;

  // Batching + réutilisation
  for (let i = 0; i < docs.length; i += EMBED_BATCH) {
    const batchDocs = docs.slice(i, i + EMBED_BATCH);

    // Détermine ce qui peut être réutilisé
    const needEmbedIdx = [];
    const needEmbedTexts = [];
    for (let j = 0; j < batchDocs.length; j++) {
      const doc = batchDocs[j];
      const key = `${doc.metadata.fullPath}#${doc.metadata.chunk}#${hashStr(doc.text)}`;
      const prevVec = prevMap.get(key);
      if (prevVec) {
        vectors[i + j] = prevVec;
        reused++;
      } else {
        needEmbedIdx.push(i + j);
        needEmbedTexts.push(doc.text);
      }
    }

    // Embeddings pour le reste
    if (needEmbedTexts.length) {
      const batchVecs = await embedder.embedDocuments(needEmbedTexts);
      computed += batchVecs.length;
      for (let k = 0; k < batchVecs.length; k++) {
        vectors[needEmbedIdx[k]] = batchVecs[k];
      }
    }
    process.stdout.write(`\r   → progress: ${human(Math.min(i + EMBED_BATCH, docs.length))}/${human(docs.length)}   `);
  }
  process.stdout.write("\n");
  const dim = vectors[0]?.length || 0;
  if (!dim) {
    console.error("❌ Embeddings vides (clé GEMINI/API ?)");
    process.exit(1);
  }
  console.log(`✅ Embeddings ok (dim=${dim}) | réutilisés=${human(reused)} | calculés=${human(computed)}`);

  // Sauvegarde
  await fs.promises.mkdir(OUT_DIR, { recursive: true });

  // Petit tri stable par (source, chunk) pour reproductibilité
  const order = docs
    .map((d, i) => ({ i, k: `${d.metadata.source}#${d.metadata.chunk}` }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((x) => x.i);

  const docsSorted = order.map((i) => docs[i]);
  const vecsSorted = order.map((i) => vectors[i]);

  await fs.promises.writeFile(
    OUT_FILE,
    JSON.stringify(
      {
        model: "text-embedding-004",
        createdAt: new Date().toISOString(),
        dim,
        docs: docsSorted,     // [{ text, metadata:{source,fullPath,chunk} }]
        vectors: vecsSorted,  // number[][]
      },
      null,
      0
    )
  );

  console.log(`💾 Écrit → ${OUT_FILE}`);
  console.log(`⏱️  Terminé en ${since()}.`);
}

main().catch((e) => {
  console.error("\n💥 Échec indexation:", e);
  process.exit(1);
});
