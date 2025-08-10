// adapters/search/json.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VECTOR_DIR = path.resolve(__dirname, "..", "..", process.env.VECTOR_DIR || "vectorstore");
const INDEX_FILE = path.join(VECTOR_DIR, "index.json");

// ---- Index en mémoire -------------------------------------------------------
let INDEX = null; // { model, dim, docs:[{text,metadata}], vectors:number[][], createdAt }

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    const e = new Error("VECTOR_INDEX_NOT_FOUND");
    e.path = INDEX_FILE;
    throw e;
  }
  const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  // Optimisation: Float32Array
  raw.vectors = raw.vectors.map((v) => Float32Array.from(v));
  INDEX = raw;
  return INDEX;
}
function ensureIndex() {
  return INDEX || loadIndex();
}

// ---- Similarité cosinus -----------------------------------------------------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

// ---- Embeddings + petit cache LRU ------------------------------------------
const embedder = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY,
  model: "text-embedding-004",
});

const LRU_SIZE = Number(process.env.EMBED_CACHE_SIZE || 200);
const LRU_TTL  = Number(process.env.EMBED_CACHE_TTL_MS || 30 * 60 * 1000); // 30 min

const cache = new Map(); // key -> { vec: number[], t: timestamp }
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.t > LRU_TTL) { cache.delete(key); return null; }
  // refresh LRU
  cache.delete(key); cache.set(key, { ...item, t: Date.now() });
  return item.vec;
}
function cacheSet(key, vec) {
  cache.set(key, { vec, t: Date.now() });
  if (cache.size > LRU_SIZE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}
async function embedQuery(text) {
  const key = String(text || "").slice(0, 4096);
  const hit = cacheGet(key);
  if (hit) return hit;
  const vec = await embedder.embedQuery(key);
  cacheSet(key, vec);
  return vec;
}

// ---- MMR (Maximal Marginal Relevance) --------------------------------------
/**
 * mmrSelect: Diversifie les résultats pour éviter les doublons proches.
 * @param {Float32Array} qVec
 * @param {Array<{i:number, score:number}>} ranked
 * @param {Array<Float32Array>} allVectors
 * @param {number} k
 * @param {number} lambda  (0..1) 1=pertinence seule, 0=diversité seule
 */
function mmrSelect(qVec, ranked, allVectors, k = 5, lambda = 0.7) {
  const selected = [];
  const candidates = ranked.map((r) => r.i);
  while (selected.length < Math.min(k, candidates.length)) {
    let best = null;
    for (const idx of candidates) {
      const rel = cosine(qVec, allVectors[idx]); // pertinence
      let div = 0;
      for (const s of selected) {
        div = Math.max(div, cosine(allVectors[idx], allVectors[s]));
      }
      const mmr = lambda * rel - (1 - lambda) * div;
      if (!best || mmr > best.mmr) best = { i: idx, mmr, rel };
    }
    selected.push(best.i);
    const pos = candidates.indexOf(best.i);
    if (pos >= 0) candidates.splice(pos, 1);
  }
  // Conserve aussi le score initial si dispo
  return selected.map((i) => ({
    i,
    s: ranked.find((r) => r.i === i)?.score ?? 0,
  }));
}

// ---- Utils ------------------------------------------------------------------
const uniq = (arr) => [...new Set(arr)];
const basename = (p) => {
  try { return path.basename(String(p || "")); } catch { return String(p || ""); }
};

// ---- API publique -----------------------------------------------------------
/**
 * search({query, queries, topK, minScore, mmr, preview})
 * - queries: tableau de reformulations; si présent, ignore `query`
 * - minScore: filtre des résultats trop faibles (0..1) — peut être null/undefined/""
 */
export async function search({ query, queries, topK = 3, minScore, mmr = true, preview = 220 }) {
  const idx = ensureIndex();
  const qRaw = Array.isArray(queries) && queries.length ? queries : [String(query || "")];
  const qList = uniq(qRaw.map((q) => String(q || "").trim()).filter(Boolean));
  if (!qList.length) return [];

  // Embeddings
  const qVecs = [];
  for (const q of qList) qVecs.push(Float32Array.from(await embedQuery(q)));

  // Vérifie la dimension
  const dim = Number(idx.dim);
  for (const v of qVecs) {
    if (v.length !== dim) {
      const e = new Error("EMBED_DIM_MISMATCH");
      e.details = { indexDim: dim, queryDim: v.length, indexModel: idx.model };
      throw e;
    }
  }

  // 1) Score chaque doc pour chaque variante, puis merge (max score par doc)
  const merged = new Map(); // indexDoc -> { score }
  for (const qv of qVecs) {
    idx.vectors.forEach((v, i) => {
      const s = cosine(qv, v);
      const cur = merged.get(i);
      if (!cur || s > cur.score) merged.set(i, { score: s });
    });
  }

  // 2) Liste triée décroissante
  let ranked = [...merged.entries()].map(([i, { score }]) => ({ i, score }));
  ranked.sort((a, b) => b.score - a.score);

  // 3) MMR (facultatif) pour diversité
  if (mmr && ranked.length > topK) {
    const head = ranked.slice(0, Math.max(topK * 3, 20));
    ranked = mmrSelect(qVecs[0], head, idx.vectors, topK, 0.7);
  } else {
    ranked = ranked.slice(0, topK);
  }

  // 4) Assemblage des résultats
  const results = ranked.map(({ i, s }) => {
    const doc = idx.docs[i] || {};
    const text = String(doc.text || "");
    const prev = text.slice(0, Math.max(20, preview)).replace(/\s+/g, " ").trim();
    const src = basename(doc.metadata?.source || "source");
    return {
      score: typeof s === "number" ? s : 0,
      text,
      metadata: doc.metadata || {},
      source: src,
      preview: prev,
    };
  });

  // 5) Filtre minScore si défini
  const threshold =
    (minScore === "" || minScore === undefined || minScore === null)
      ? null
      : Number(minScore);
  return threshold == null
    ? results
    : results.filter((r) => r.score >= threshold);
}

export function reload() {
  INDEX = null;
  return ensureIndex();
}

export function stats() {
  const i = ensureIndex();
  return {
    backend: "json",
    model: i.model,
    dim: i.dim,
    docs: i.docs.length,
    vectors: i.vectors.length,
    createdAt: i.createdAt,
    path: INDEX_FILE,
  };
}

/** Petit smoke-test à appeler au démarrage serveur. */
export async function ensureReady() {
  if (!process.env.GEMINI_API_KEY) {
    const e = new Error("GEMINI_API_KEY_MISSING");
    e.hint = "Définis GEMINI_API_KEY pour les embeddings de recherche.";
    throw e;
  }
  const s = stats(); // force le chargement de l’index
  if (!s.vectors || s.vectors !== s.docs) {
    // Ce n’est pas forcément bloquant, mais on le signale
    // (certains index regroupent plusieurs chunks par doc).
  }
  return s;
}
