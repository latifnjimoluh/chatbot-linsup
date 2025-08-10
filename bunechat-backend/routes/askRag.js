// routes/askRag.js
import express from "express";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSearch } from "../adapters/search/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KB_DIR = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");

// -------- Env & bornes --------
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const TOP_K        = clamp(Number(process.env.RAG_TOP_K || 3), 1, 10);
const MIN_SCORE    = (() => {
  const v = process.env.RAG_MIN_SCORE;
  if (v == null || v === "" || Number.isNaN(Number(v))) return undefined; // désactivé
  return Number(v);
})();
const QVARIANTS    = clamp(Number(process.env.RAG_QVARIANTS || 1), 1, 3);
const ARBITER_MODE = (process.env.RAG_ARBITER || "rules").toLowerCase(); // rules | llm | off
const MAX_CTX_CH   = clamp(Number(process.env.RAG_MAX_CONTEXT_CHARS || 8000), 2000, 40000);

// -------- Variantes simples (sans LLM) --------
const SYN = [
  [/\\brelancer\\b/gi, "redémarrer"],
  [/\\brestart\\b/gi, "redémarrer"],
  [/\\bservice\\b/gi, "daemon"],
  [/\\bconf(ig)?\\b/gi, "configuration"],
];

function makeVariants(q, n) {
  const out = [String(q || "").trim()];
  if (n <= 1) return out.filter(Boolean);

  // Variante 1: sans stopwords très simples
  const stop = /\\b(le|la|les|un|une|des|de|du|dans|sur|pour|avec|et|ou|à|au|aux|en)\\b/gi;
  out.push(q.replace(stop, " ").replace(/\\s+/g, " ").trim());

  // Variante 2: synonymes ciblés (DNS/BIND, op sys)
  if (n >= 3) {
    let v = q;
    for (const [re, rep] of SYN) v = v.replace(re, rep);
    out.push(v.trim());
  }

  // dédoublonne + nettoie
  return [...new Set(out)].filter((s) => s && s.length > 0).slice(0, n);
}

// -------- Prompt helpers --------
function normSource(s) {
  // Garde seulement le nom de fichier pour l'affichage/validation
  try { return path.basename(String(s || "").trim()); } catch { return String(s || ""); }
}

function buildPrompt({ system, question, context }) {
  const RULES = [
    "Tu t'appuies STRICTEMENT sur le CONTEXTE fourni.",
    "Si une info n'est pas dans le contexte, dis-le clairement ('je n'ai pas trouvé').",
    "Réponds en français, technique et concis.",
    "NE mets pas 'Sources:' au milieu de la réponse.",
    "Termine impérativement par UNE LIGNE unique: Sources: <fichier1>, <fichier2>",
  ].join("\n- ");

  const ctxStr = context.map((c, i) => {
    const src = normSource(c.source);
    const score = typeof c.score === "number" ? c.score.toFixed(3) : "n/a";
    return `<<<DOC #${i + 1} source="${src}" score=${score}>>>
${c.text}
<<<END DOC>>>`;
  }).join("\n\n");

  return (
`SYSTEM:
${system}

REGLES:
- ${RULES.join("\n- ")}

CONTEXTE:
${ctxStr}

QUESTION:
${question}

ASSISTANT:`).trim();
}

// -------- Arbitre (rules/LLM/off) --------
function parseSourcesLine(s) {
  // accepte: "Sources: a,b", "Sources: a; b", listes
  if (!s) return [];
  const line = (s.split("\n").find((l) => /\\bSources\\s*:/i.test(l)) || "")
                .replace(/.*Sources\\s*:/i, "");
  return line
    .split(/[;,]/g)
    .map((x) => normSource(x).trim())
    .filter(Boolean);
}

async function arbitrate({ mode, model, question, context, draft, allowedSources }) {
  if (mode === "off") return { final: draft };

  if (mode === "rules") {
    // doit contenir "Sources:"
    if (!/(^|\\n)\\s*Sources\\s*:/i.test(draft)) {
      return { final: "Je n'ai pas trouvé d'information suffisante dans la base pour répondre précisément." };
    }
    const cited = parseSourcesLine(draft);
    if (cited.length === 0) {
      return { final: "Je n'ai pas trouvé d'information suffisante dans la base pour répondre précisément." };
    }
    // toutes les sources citées doivent appartenir aux sources autorisées
    const allowed = new Set(allowedSources.map(normSource));
    const bad = cited.some((n) => !allowed.has(normSource(n)));
    if (bad) {
      return { final: "Réponse invalide (sources non reconnues). Je n'ai pas trouvé mieux dans la base." };
    }
    return { final: draft };
  }

  // Mode LLM: deuxième passe “referee”
  const refereePrompt =
`SYSTEM:
Tu es un arbitre. Tu dois vérifier que la réponse proposée s'appuie UNIQUEMENT
sur les extraits fournis. Si nécessaire, corrige la réponse pour qu'elle se limite
strictement aux informations du contexte et termine par 'Sources: <fichiers>'.

CONTEXTE:
${context.map((c, i) => `#${i + 1} [${normSource(c.source)}]
${c.text}`).join("\n\n---\n\n")}

QUESTION:
${question}

REPONSE PROPOSEE:
${draft}

INSTRUCTIONS:
- Si la réponse contient des éléments non présents dans le CONTEXTE, retire-les.
- Termine impérativement par 'Sources: <fichiers>' avec uniquement les fichiers utilisés (noms simples).`;

  try {
    const result = await model.generateContent(refereePrompt);
    const text = result?.response?.text?.() || draft;
    return { final: text };
  } catch {
    return { final: draft };
  }
}

// -------- Route factory --------
export default function createAskRagRouter({ model, SYSTEM_PROMPT, logChat }) {
  const router = express.Router();
  const search = getSearch();

  router.post("/", async (req, res) => {
    const started = Date.now();
    const rid = req.id || nanoid(10);
    res.setHeader("x-rid", rid);

    try {
      const { messages = [] } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages[] requis" });
      }

      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const question = String(lastUser?.content || "").trim();
      if (!question) return res.status(400).json({ error: "question vide" });

      // 1) Variantes
      const variants = makeVariants(question, QVARIANTS);

      // 2) Recherche (seuil + MMR)
      const hits = await search.search({
        queries: variants,
        topK: TOP_K,
        minScore: MIN_SCORE,   // undefined => désactivé
        mmr: true,
        preview: 260,
      });

      // 2b) Trim du contexte total
      let total = 0;
      const ctx = [];
      for (const h of hits) {
        const txt = String(h.text || "");
        if (!txt) continue;
        if (total + txt.length > MAX_CTX_CH) break;
        ctx.push({ source: h.source, score: h.score, text: txt });
        total += txt.length;
      }

      if (!ctx.length) {
        const durationMs = Date.now() - started;
        logChat?.({ rid, t: new Date().toISOString(), ip: req.ip, ok: true, mode: "rag:none", durationMs, aChars: 0 });
        const actions = [{
          id: nanoid(6),
          type: "ask_followup",
          label: "Me demander les logs",
          payload: { suggestion: "Peux-tu coller la sortie de `journalctl -u <service> -n 80` ?" },
        }];
        return res.json({
          reply: "Je n'ai pas trouvé d'information pertinente dans la base pour répondre précisément.",
          meta: { rid, durationMs, sources: [], evidence: [] },
          actions,
        });
      }

      // Evidence pour l’UI
      const evidence = hits.map((h) => ({
        source: normSource(h.source),
        score: typeof h.score === "number" ? h.score.toFixed(3) : String(h.score ?? ""),
        preview: h.preview || "",
      }));

      const sources = [...new Set(ctx.map((h) => normSource(h.source)))];

      // 2c) Actions heuristiques
      const actions = [];
      for (const s of sources.slice(0, 3)) {
        if (!/\.(md|txt|sh|log)$/i.test(s)) continue;
        try {
          const full = path.join(KB_DIR, s);
          if (fs.existsSync(full)) {
            actions.push({
              id: nanoid(6),
              type: "show_file",
              label: `Ouvrir ${s}`,
              payload: { source: s },
            });
          }
        } catch {}
      }
      const qLow = question.toLowerCase();
      const ctxLow = ctx.map((c) => c.text.toLowerCase()).join(" ");
      if (qLow.includes("dns") || qLow.includes("bind") || ctxLow.includes("dns") || ctxLow.includes("bind")) {
        actions.push({
          id: nanoid(6),
          type: "propose_fix",
          label: "Proposer un correctif Bind9",
          payload: { topic: "dns_bind9" },
        });
      }
      if (qLow.includes("ssh")) {
        actions.push({
          id: nanoid(6),
          type: "propose_fix",
          label: "Renforcer SSH",
          payload: { topic: "ssh_hardening" },
        });
      }
      actions.push({
        id: nanoid(6),
        type: "ask_followup",
        label: "Me demander les logs",
        payload: { suggestion: "Peux-tu coller la sortie de `journalctl -u <service> -n 80` ?" },
      });

      // 3) Prompt enrichi
      const prompt = buildPrompt({
        system: SYSTEM_PROMPT,
        question,
        context: ctx,
      });

      // 4) Appel LLM (timeout robuste)
      const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
      const draft = await Promise.race([
        model.generateContent(prompt).then((r) => r?.response?.text?.() || ""),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ]);

      // 5) Arbitre
      const { final } = await arbitrate({
        mode: ARBITER_MODE,
        model,
        question,
        context: ctx,
        draft,
        allowedSources: sources,
      });

      const durationMs = Date.now() - started;
      logChat?.({
        rid, t: new Date().toISOString(), ip: req.ip,
        durationMs, ok: true, mode: `rag(topK=${TOP_K},min=${MIN_SCORE ?? "off"})`,
        qChars: question.length, aChars: final.length, sources,
      });

      return res.json({ reply: final, meta: { rid, durationMs, sources, evidence }, actions });
    } catch (err) {
      const durationMs = Date.now() - started;

      const msg = String(err?.message || "");
      if (msg.includes("Too Many Requests") || msg.includes("quota")) {
        return res.status(429).json({
          error: "quota_exceeded",
          retryAfterSec: 60,
          rid, durationMs,
        });
      }

      const status = msg === "timeout" ? 504 : 500;
      return res.status(status).json({ error: "LLM_error", rid, durationMs });
    }
  });

  return router;
}
