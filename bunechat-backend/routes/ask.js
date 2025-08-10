// routes/ask.js
import express from "express";
import { nanoid } from "nanoid";

/** -------- Utils -------- **/

// Timeout global simple
const withTimeout = (p, ms) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);

// Anti-injection basique + bornage
const stripControlTokens = (s = "") =>
  String(s)
    .replace(/^\s*(SYSTEM|ASSISTANT|USER)\s*:\s*/gim, "")
    .slice(0, 4000);

// Build prompt façon “chat transcript”
const buildPrompt = (messages = [], SYSTEM_PROMPT = "") => {
  const safe = (Array.isArray(messages) ? messages : [])
    .slice(-15)
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: stripControlTokens(m?.content || ""),
    }))
    .filter((m) => m.content.trim().length > 0);

  const SCOPE_RULES =
    "Si la question sort du périmètre (BUNEC, DevOps, Linux, Terraform, Proxmox, supervision, sécurité), " +
    "réponds brièvement que ce n’est pas couvert puis recadre vers le projet.";

  const prompt =
    `SYSTEM:\n${SYSTEM_PROMPT}\n\nRÈGLES:\n${SCOPE_RULES}\n\n` +
    safe.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n") +
    `\nASSISTANT:`;

  return { safe, prompt };
};

// Essaie d’estimer un retry-after en secondes depuis l’erreur Gemini
function parseRetryAfterSec(err) {
  try {
    const arr = err?.errorDetails || [];
    for (const item of arr) {
      if (String(item?.["@type"] || "").includes("RetryInfo")) {
        const s = String(item?.retryDelay || "").trim(); // ex: "46s"
        const m = s.match(/^(\d+)\s*s?$/i);
        if (m) return Number(m[1]);
      }
    }
  } catch {}
  return null;
}

/** -------- Router -------- **/
export default function createAskRouter({ model, SYSTEM_PROMPT, logChat }) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const started = Date.now();
    const rid = req.id || nanoid(10);
    res.setHeader("x-rid", rid);

    try {
      const { messages = [] } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages[] requis" });
      }

      const { safe, prompt } = buildPrompt(messages, SYSTEM_PROMPT);
      const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000);

      const result = await withTimeout(model.generateContent(prompt), timeoutMs);
      const text =
        result?.response?.text?.() ||
        "Désolé, je n'ai pas pu générer de réponse.";

      const durationMs = Date.now() - started;

      try {
        logChat?.({
          rid,
          t: new Date().toISOString(),
          ip: req.ip,
          durationMs,
          ok: true,
          mode: "plain",
          qChars: safe?.[safe.length - 1]?.content?.length || 0,
          aChars: text.length,
        });
      } catch {}

      return res.json({ reply: text, meta: { durationMs, rid } });
    } catch (err) {
      const durationMs = Date.now() - started;

      // Quota Gemini → 429
      if (err?.status === 429 || /quota|Too Many Requests/i.test(String(err?.message))) {
        return res
          .status(429)
          .json({ error: "quota_exceeded", retryAfterSec: parseRetryAfterSec(err), rid, durationMs });
      }

      if (err?.message === "timeout") {
        return res.status(504).json({ error: "LLM_error", rid, durationMs });
      }

      req.log?.error?.({ err, rid }, "chatbot_error");
      return res.status(500).json({ error: "LLM_error", rid, durationMs });
    }
  });

  return router;
}
