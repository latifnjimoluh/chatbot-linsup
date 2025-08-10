// routes/agent.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KB_DIR = path.resolve(__dirname, "..", process.env.KB_DIR || "knowledge_base");

// ---------------- Tools definition ----------------
export default function createAgentRouter({ model, search }) {
  const router = express.Router();

  const TOOLS = {
    search_kb: {
      desc: "Recherche dans la base de connaissances",
      params: { query: "string" },
      async run({ query }) {
        const res = await search?.search?.(String(query || ""));
        return Array.isArray(res) ? res.slice(0, 3) : [];
      },
    },
    show_file: {
      desc: "Affiche un fichier autorisé du dossier KB",
      params: { source: "string" },
      async run({ source }) {
        const base = path.basename(String(source || ""));
        const full = path.join(KB_DIR, base);
        if (!full.startsWith(KB_DIR)) throw new Error("forbidden");
        return fs.readFileSync(full, "utf8").slice(0, 4000);
      },
    },
    propose_fix: {
      desc: "Propose un correctif pour un sujet connu",
      params: { topic: "string" },
      async run({ topic }) {
        switch (String(topic || "")) {
          case "dns_bind9":
            return "Vérifie named.conf, ouvre le port 53 UDP/TCP, redémarre le service.";
          case "ssh_hardening":
            return "Désactive root, impose les clés, active fail2ban et change le port.";
          default:
            return "Aucun correctif disponible.";
        }
      },
    },
    ask_followup: {
      desc: "Suggère une question de suivi",
      params: { suggestion: "string" },
      async run({ suggestion }) {
        return suggestion || "Peux-tu préciser ?";
      },
    },
  };

  const toolSpecs = Object.entries(TOOLS).map(([name, t]) => ({
    name,
    desc: t.desc,
    params: t.params,
  }));

  async function agentLoop(question, maxSteps = 3) {
    const context = [];
    const actions = [];

    for (let i = 0; i < maxSteps; i++) {
      const prompt = JSON.stringify({
        question,
        context,
        tools: toolSpecs,
        format: { action: { tool: "string", args: {} }, thought: "string", final: "string" },
      });
      const raw = await model
        .generateContent(prompt)
        .then((r) => r?.response?.text?.() || "{}");
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        return { reply: "Réponse invalide de l'agent.", actions };
      }
      if (obj.final) return { reply: obj.final, actions };
      if (obj.action?.tool) {
        const tool = TOOLS[obj.action.tool];
        if (!tool) continue;
        try {
          const result = await tool.run(obj.action.args || {});
          context.push({ tool: obj.action.tool, result });
          actions.push({ tool: obj.action.tool, args: obj.action.args || {}, result });
        } catch (err) {
          const msg = String(err?.message || "error");
          context.push({ tool: obj.action.tool, error: msg });
          actions.push({ tool: obj.action.tool, args: obj.action.args || {}, error: msg });
        }
      }
    }
    return { reply: "Je n'ai pas pu répondre dans la limite d'itérations.", actions };
  }

  router.post("/", async (req, res) => {
    const question = req.body?.question || req.body?.messages?.[0]?.content;
    if (!question) return res.status(400).json({ error: "question_requise" });
    try {
      const { reply, actions } = await agentLoop(String(question));
      return res.json({ reply, actions, meta: { steps: actions.length } });
    } catch (err) {
      req.log?.error?.({ err }, "agent_failed");
      return res.status(500).json({ error: "agent_error" });
    }
  });

  return router;
}

