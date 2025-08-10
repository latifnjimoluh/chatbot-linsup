// routes/kb.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KB_DIR = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");
const ALLOWED = new Set([".md", ".txt", ".log", ".sh", ".conf", ".cfg", ".ini", ".yaml", ".yml"]);
const MAX_FILE_SIZE = 200 * 1024; // 200 Ko

async function walk(dir) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (ALLOWED.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

const fileLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

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

  // --- Liste des fichiers de la KB ---
  router.get("/files", async (_req, res) => {
    try {
      const files = await walk(KB_DIR);
      const out = await Promise.all(
        files.map(async (f) => {
          const st = await fs.promises.stat(f).catch(() => null);
          if (!st) return null;
          return { name: path.basename(f), size: st.size, mtime: st.mtimeMs };
        })
      );
      res.json({ files: out.filter(Boolean) });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // --- Lecture d'un fichier ---
  router.get("/file", fileLimiter, async (req, res) => {
    const rid = req.id || nanoid(10);
    res.setHeader("x-rid", rid);
    try {
      const name = String(req.query.source || "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        return res.status(400).json({ error: "invalid_source", rid });
      }
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED.has(ext)) return res.status(400).json({ error: "forbidden_ext", rid });
      const full = path.join(KB_DIR, name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || !st.isFile()) return res.status(404).json({ error: "not_found", rid });
      if (st.size > MAX_FILE_SIZE) return res.status(413).json({ error: "too_large", rid });
      const content = await fs.promises.readFile(full, "utf8");
      req.log?.info?.({ rid, action: "show_file", source: name, ip: req.ip }, "kb_file");
      res.json({ source: name, content });
    } catch (err) {
      res.status(500).json({ error: "read_error", rid });
    }
  });

  return router;
}
