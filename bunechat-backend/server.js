// server.js
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import { nanoid } from "nanoid";
import { GoogleGenerativeAI } from "@google/generative-ai";
import rateLimit from "express-rate-limit";

import createAskRouter from "./routes/ask.js";
import createAskStreamRouter from "./routes/askStream.js";
import createAskRagRouter from "./routes/askRag.js";
import createAgentRouter from "./routes/agent.js";
import createKbRouter from "./routes/kb.js";
import { getSearch } from "./adapters/search/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------------- Adapter de recherche (JSON par défaut) ---------------------- */
const search = getSearch();                 // -> { name, ensureReady?, reload?, stats?, search() }
await search.ensureReady?.().catch(() => {}); // charge l'index JSON, ou no-op si absent

/* ---------------------- App & middlewares ---------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use(
  pinoHttp({
    logger,
    genReqId: () => nanoid(10),
  })
);

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/chatbot", limiter);

// JSONL app log des échanges
const chatLogPath = path.join(logsDir, "chat.log");
const logChat = (entry) => {
  try {
    fs.appendFile(chatLogPath, JSON.stringify(entry) + "\n", () => {});
  } catch {}
};

/* ---------------------- Gemini model (+fallback optionnel) ---------------------- */
if (!process.env.GEMINI_API_KEY) {
  logger.warn("GEMINI_API_KEY manquant dans .env");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const MODEL_ID = process.env.MODEL_ID || "gemini-1.5-flash";
const MODEL_FALLBACK_ID = process.env.MODEL_FALLBACK_ID || ""; // ex: "gemini-1.5-flash-8b"

const modelPrimary = genAI.getGenerativeModel({ model: MODEL_ID });
const modelFallback = MODEL_FALLBACK_ID
  ? genAI.getGenerativeModel({ model: MODEL_FALLBACK_ID })
  : null;

// Mux qui tente le fallback uniquement en cas de 429 (quota)
const model = {
  async generateContent(prompt) {
    try {
      return await modelPrimary.generateContent(prompt);
    } catch (err) {
      const msg = String(err?.message || "");
      if ((err?.status === 429 || /Too Many Requests|quota/i.test(msg)) && modelFallback) {
        return await modelFallback.generateContent(prompt);
      }
      throw err;
    }
  },
  async generateContentStream(prompt) {
    try {
      return await modelPrimary.generateContentStream(prompt);
    } catch (err) {
      const msg = String(err?.message || "");
      if ((err?.status === 429 || /Too Many Requests|quota/i.test(msg)) && modelFallback) {
        return await modelFallback.generateContentStream(prompt);
      }
      throw err;
    }
  },
};

/* ---------------------- Prompt système commun ---------------------- */
export const SYSTEM_PROMPT =
  "Tu es assistant BUNEC. Réponds en français, techniquement et de façon concise, " +
  "avec des étapes actionnables (DevOps, Linux, Terraform, Proxmox, supervision, sécurité). " +
  "Si la question sort du périmètre, réponds brièvement puis recadre vers le projet.";

/* ---------------------- Health ---------------------- */
app.get("/healthz", (_req, res) => res.send("ok"));

/* ---------------------- Logs backend ---------------------- */
logger.info({ backend: search?.name || "json" }, "search_backend_ready");

/* ---------------------- Routes ---------------------- */
// Phase A: chat simple + stream
app.use("/chatbot/ask",        createAskRouter({       model, SYSTEM_PROMPT, logChat }));
app.use("/chatbot/ask/stream", createAskStreamRouter({ model, SYSTEM_PROMPT, logChat }));
app.use("/chatbot/agent",      createAgentRouter({ model, search }));

// Phase B: RAG (on **injecte** l'adapter)
app.use("/chatbot/ask/rag",    createAskRagRouter({    model, SYSTEM_PROMPT, logChat, search }));

// Outils KB (reload/stats/ready)
app.use("/kb", createKbRouter({ search }));

/* ---------------------- 404 ---------------------- */
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

/* ---------------------- Start ---------------------- */
const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => {
  logger.info(`API up on http://localhost:${PORT}`);
  if (MODEL_FALLBACK_ID) {
    logger.info({ primary: MODEL_ID, fallback: MODEL_FALLBACK_ID }, "gemini_models");
  } else {
    logger.info({ primary: MODEL_ID }, "gemini_model");
  }
});
