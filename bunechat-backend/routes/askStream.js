// routes/askStream.js
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

// Granularité & rythme (via ENV)
const STREAM_SPLIT = (process.env.STREAM_SPLIT || "chunk").toLowerCase(); // chunk|word|char
const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS || 0);         // délai entre pièces
const HEARTBEAT_MS = Number(process.env.STREAM_HEARTBEAT_MS || 15000);    // keep-alive SSE

const splitText = (t) => {
  if (STREAM_SPLIT === "char") return [...t];           // caractère par caractère
  if (STREAM_SPLIT === "word") return t.split(/(\s+)/); // mots + espaces (préserve les espaces)
  return [t];                                           // chunk brut
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** -------- Router -------- **/
export default function createAskStreamRouter({ model, SYSTEM_PROMPT, logChat }) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const started = Date.now();
    const rid = req.id || nanoid(10);
    res.setHeader("x-rid", rid);

    // Prépare les en-têtes SSE *avant* tout write
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // utile si Nginx
    res.flushHeaders?.();

    let clientClosed = false;
    const endSafe = () => {
      if (!clientClosed) {
        try { res.end(); } catch {}
        clientClosed = true;
      }
    };
    req.on("close", () => { clientClosed = true; });

    const send = (obj) => {
      if (clientClosed) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { clientClosed = true; }
    };

    // Heartbeat pour garder la connexion ouverte (proxies/NGINX)
    const heartbeat = setInterval(() => {
      if (!clientClosed) { try { res.write(`: ping ${Date.now()}\n\n`); } catch { clientClosed = true; } }
    }, HEARTBEAT_MS > 0 ? HEARTBEAT_MS : 2147483647);

    try {
      const { messages = [] } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        send({ error: "messages[] requis" }); return endSafe();
      }

      const { safe, prompt } = buildPrompt(messages, SYSTEM_PROMPT);
      if (safe.length === 0) { send({ error: "contenu vide" }); return endSafe(); }

      send({ meta: { rid, split: STREAM_SPLIT, delayMs: STREAM_DELAY_MS } });

      const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
      const result = await withTimeout(model.generateContentStream(prompt), timeoutMs);

      let full = "";
      for await (const chunk of result.stream) {
        if (clientClosed) break;
        const delta = chunk?.text?.();
        if (!delta) continue;

        const pieces = splitText(delta);
        for (const piece of pieces) {
          if (clientClosed) break;
          full += piece;
          send({ delta: piece });
          if (STREAM_SPLIT !== "chunk" && STREAM_DELAY_MS > 0) {
            await sleep(STREAM_DELAY_MS);
          }
        }
      }

      const durationMs = Date.now() - started;
      try {
        logChat?.({
          rid,
          t: new Date().toISOString(),
          ip: req.ip,
          durationMs,
          ok: true,
          mode: `stream:${STREAM_SPLIT}`,
          qChars: safe?.[safe.length - 1]?.content?.length || 0,
          aChars: full.length,
        });
      } catch {}

      send({ done: true, full, meta: { rid, durationMs } });
      endSafe();
    } catch (err) {
      // Mapping quota/timeout en SSE
      if (err?.status === 429 || /quota|Too Many Requests/i.test(String(err?.message))) {
        try { res.write(`data: ${JSON.stringify({ error: "quota_exceeded" })}\n\n`); } catch {}
      } else if (err?.message === "timeout") {
        try { res.write(`data: ${JSON.stringify({ error: "timeout" })}\n\n`); } catch {}
      } else {
        try { res.write(`data: ${JSON.stringify({ error: "LLM_error" })}\n\n`); } catch {}
      }
      endSafe();
      req.log?.error?.({ err, rid }, "chatbot_stream_error");
    } finally {
      clearInterval(heartbeat);
    }
  });

  return router;
}
