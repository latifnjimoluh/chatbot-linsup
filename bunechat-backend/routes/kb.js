// routes/kb.js
// Endpoints utilitaires relatifs à la base de connaissance (RAG)
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VECTOR_DIR = path.resolve(__dirname, "..", process.env.VECTOR_DIR || "vectorstore");
const INDEX_FILE = path.join(VECTOR_DIR, "index.json");
const KB_DIR = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");

export default function createKbRouter({ search }) {
  const router = express.Router();

  // --- Recharge l'index (JSON) sans redémarrer le serveur
  router.post("/reload", async (_req, res) => {
    try {
      if (typeof search?.reload === "function") {
        await search.reload();
      }
      // Renvoie aussi les stats pour que le frontend puisse rafraîchir l'UI
      if (fs.existsSync(INDEX_FILE)) {
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        const stats = {
          model: raw?.model || null,
          createdAt: raw?.createdAt || null,
          dim: raw?.dim || null,
          docs: Array.isArray(raw?.docs) ? raw.docs.length : null,
          vectors: Array.isArray(raw?.vectors) ? raw.vectors.length : null,
          path: INDEX_FILE,
        };
        return res.json({
          backend: search?.name || "json",
          env: {
            RAG_TOP_K: Number(process.env.RAG_TOP_K || 3),
            RAG_MIN_SCORE: process.env.RAG_MIN_SCORE === "" ? null : Number(process.env.RAG_MIN_SCORE || 0),
            RAG_QVARIANTS: Number(process.env.RAG_QVARIANTS || 1),
          },
          stats,
        });
      }
      res.json({ ok: true, backend: search?.name || "json" });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // --- Statistiques de la KB
  router.get("/stats", async (_req, res) => {
    try {
      const backend = search?.name || "json";
      const env = {
        RAG_TOP_K: Number(process.env.RAG_TOP_K || 3),
        RAG_MIN_SCORE:
          process.env.RAG_MIN_SCORE === "" ? null : Number(process.env.RAG_MIN_SCORE || 0),
        RAG_QVARIANTS: Number(process.env.RAG_QVARIANTS || 1),
        RAG_ARBITER: (process.env.RAG_ARBITER || "rules"),
      };

      if (backend === "json") {
        if (!fs.existsSync(INDEX_FILE)) {
          return res.status(404).json({ backend, error: "index.json introuvable" });
        }
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        const stats = {
          model: raw?.model || null,
          createdAt: raw?.createdAt || null,
          dim: raw?.dim || null,
          docs: Array.isArray(raw?.docs) ? raw.docs.length : null,
          vectors: Array.isArray(raw?.vectors) ? raw.vectors.length : null,
          path: INDEX_FILE,
        };
        return res.json({ backend, env, stats });
      }

      // Pinecone (si tu l’actives plus tard)
      if (backend === "pinecone") {
        const stats = {
          index: process.env.PINECONE_INDEX || null,
          namespace: process.env.PINECONE_NAMESPACE || null,
          note: "Stats détaillées côté Pinecone non interrogées depuis cette route.",
        };
        return res.json({ backend, env, stats });
      }

      res.json({ backend, env });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // --- Lecture read-only d’un fichier de la KB (Phase C)
  router.get("/file", async (req, res) => {
    try {
      const q = String(req.query.source || "").trim();
      if (!q) return res.status(400).json({ error: "source manquant" });

      // nom de fichier simple uniquement
      const base = path.basename(q);
      const full = path.join(KB_DIR, base);

      // full doit rester DANS KB_DIR
      const rel = path.relative(KB_DIR, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return res.status(400).json({ error: "chemin invalide" });
      }
      if (!fs.existsSync(full)) {
        return res.status(404).json({ error: "fichier introuvable" });
      }
      const max = 200 * 1024; // 200KB
      const buf = await fs.promises.readFile(full);
      const content = buf.slice(0, max).toString("utf8");
      res.json({ source: base, size: buf.length, truncated: buf.length > max, content });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return router;
}
