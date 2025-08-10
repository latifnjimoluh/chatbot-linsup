// routes/kb.js
import express from "express";

export default function createKbRouter({ search }) {
  const router = express.Router();

  const envSnapshot = () => ({
    RAG_TOP_K: Number(process.env.RAG_TOP_K || 3),
    RAG_MIN_SCORE:
      process.env.RAG_MIN_SCORE === "" || process.env.RAG_MIN_SCORE == null
        ? null
        : Number(process.env.RAG_MIN_SCORE),
    RAG_QVARIANTS: Number(process.env.RAG_QVARIANTS || 1),
    RAG_ARBITER: String(process.env.RAG_ARBITER || "rules"),
    SEARCH_BACKEND: String(process.env.SEARCH_BACKEND || "json"),
    VECTOR_DIR: String(process.env.VECTOR_DIR || "vectorstore"),
  });

  router.post("/reload", async (_req, res) => {
    try {
      await search.reload?.();
      const stats = await search.stats?.();
      res.json({ backend: search?.name || "json", env: envSnapshot(), stats });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get("/stats", async (_req, res) => {
    try {
      const stats = await search.stats?.();
      res.json({ backend: search?.name || "json", env: envSnapshot(), stats });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get("/ready", async (_req, res) => {
    try {
      await search.ensureReady?.();
      res.json({ ok: true, backend: search?.name || "json" });
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}
