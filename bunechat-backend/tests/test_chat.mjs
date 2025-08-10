// tests/test_chat.mjs
// Node >=18 (fetch natif)
import { performance } from "node:perf_hooks";

/**
 * ENV utiles :
 *   MODE=ask|stream|rag|all
 *   API_BASE=http://127.0.0.1:3002
 *   API_URL=...           (override /chatbot/ask)
 *   STREAM_URL=...        (override /chatbot/ask/stream)
 *   RAG_URL=...           (override /chatbot/ask/rag)
 *   TIMEOUT_MS=45000
 */

const MODE = (process.env.MODE || "ask").toLowerCase();
const BASE = process.env.API_BASE || "http://127.0.0.1:3002";

const ASK_URL    = process.env.API_URL    || `${BASE}/chatbot/ask`;
const STREAM_URL = process.env.STREAM_URL || `${BASE}/chatbot/ask/stream`;
const RAG_URL    = process.env.RAG_URL    || `${BASE}/chatbot/ask/rag`;

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);

// --- Jeux de questions ---
const QUESTIONS_BASE = [
  "Donne-moi un playbook durs étapes pour sécuriser SSH (no root, fail2ban, clés).",
  "Comment structurer Terraform pour déployer une VM Proxmox avec Cloud-Init?",
  "Quels checks santé système minimaux pour un serveur Ubuntu en prod?",
  "Donne un exemple de pipeline CI simple (tests, lint, build, deploy).",
  "Conseils pour journaux applicatifs : formats, rotation, centralisation?",
  "Comment exposer Proxmox API derrière Nginx en reverse proxy sécurisé?",
  "Stratégie de supervision CPU/RAM/disk + alertes simples.",
  "Checklist avant un `terraform apply` en environnement BUNEC.",
  "Bonnes pratiques pour variables sensibles (dotenv, vault)?",
  "HAProxy: un backend stateless en round-robin + healthz /healthz.",
  "Comment diagnostiquer une VM qui ne reçoit pas son IP via DHCP?",
  "Commandes Linux pour tracer ports ouverts et services (ss, systemctl).",
].slice(0, 12);

const QUESTIONS_RAG = [
  "Comment désactiver systemd-resolved pour libérer le port 53 ?",
  "Quelle commande pour vérifier la zone inverse 0.10.10.in-addr.arpa ?",
  "Quel format de Serial recommandes-tu pour la zone db.bunec.local ?",
  "Quels ports firewall ouvrir pour un DNS BIND9 (TCP/UDP) ?",
  "Où sont déclarées les zones et où stocker les fichiers de zone ?",
  "Comment activer un logging minimal de BIND9 et où lire les logs ?",
];

// --- Utils ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = async (p, ms = TIMEOUT_MS) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await p(ctl.signal);
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
};

// --- Appels ---
const askPlain = async (q) => {
  const started = performance.now();
  const res = await fetch(ASK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  const t = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const data = await res.json();
  return {
    t,
    textLen: (data.reply || "").length,
    srv: data.meta?.durationMs ?? null,
  };
};

const askRag = async (q) => {
  const started = performance.now();
  const res = await fetch(RAG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  const t = Math.round(performance.now() - started);
  if (!res.ok) {
    let msg = `HTTP_${res.status}`;
    try {
      const d = await res.json();
      if (d?.hint) msg = `⚠️ ${d.error} — ${d.hint}`;
      else if (d?.error) msg = `⚠️ ${d.error}`;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return {
    t,
    textLen: (data.reply || "").length,
    srv: data.meta?.durationMs ?? null,
    sources: Array.isArray(data.meta?.sources) ? data.meta.sources : [],
  };
};

// lecture SSE (serveur envoie "data: {...}\n\n")
const askStream = async (q) => {
  const started = performance.now();
  const res = await fetch(STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP_${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "", srv = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      // commentaires heartbeat: lignes commençant par ":" → ignorer
      if (part.startsWith(":")) continue;
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          const payload = JSON.parse(raw);
          if (payload.delta) full += payload.delta;
          if (payload.meta?.durationMs) srv = payload.meta.durationMs;
          if (payload.done) {
            // on laisse la boucle se terminer naturellement
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const t = Math.round(performance.now() - started);
  return { t, textLen: full.length, srv };
};

// --- Runner ---
(async () => {
  const stats = { ok: 0, fails: 0, times: [] };

  const runSet = async (label, url, fn, arr) => {
    console.log(`\n→ Test ${label} vers ${url}`);
    for (const q of arr) {
      try {
        const { t, textLen, srv } = await withTimeout(() => fn(q), TIMEOUT_MS);
        stats.ok++; stats.times.push(t);
        console.log(`✔︎ ${t} ms (srv=${srv ?? "?"} ms) | chars=${textLen} | ${q.slice(0, 44)}...`);
      } catch (e) {
        stats.fails++;
        const code = e?.cause?.code || e?.code || e?.name || "n/a";
        console.log(`✖︎ FAIL: ${e.message} (code=${code}) | ${q.slice(0, 44)}...`);
      }
      // évite d'inonder l'API
      await sleep(200);
    }
  };

  if (MODE === "ask" || MODE === "all") {
    await runSet("ASK (non-stream)", ASK_URL, askPlain, QUESTIONS_BASE);
  }
  if (MODE === "stream" || MODE === "all") {
    // on prend 4 questions pour le stream, c'est suffisant
    await runSet("STREAM (SSE)", STREAM_URL, askStream, QUESTIONS_BASE.slice(0, 4));
  }
  if (MODE === "rag" || MODE === "all") {
    console.log(`\n→ Test RAG vers ${RAG_URL}`);
    for (const q of QUESTIONS_RAG) {
      try {
        const { t, textLen, srv, sources } = await withTimeout(() => askRag(q), TIMEOUT_MS);
        stats.ok++; stats.times.push(t);
        const src = sources.length ? sources.join(", ") : "—";
        console.log(`✔︎ ${t} ms (srv=${srv ?? "?"} ms) | chars=${textLen} | src=[${src}] | ${q.slice(0, 44)}...`);
      } catch (e) {
        stats.fails++;
        const code = e?.cause?.code || e?.code || e?.name || "n/a";
        console.log(`✖︎ FAIL: ${e.message} (code=${code}) | ${q.slice(0, 44)}...`);
      }
      await sleep(200);
    }
  }

  // Erreur réseau volontaire sur l'URL du mode principal (ASK par défaut)
  const baseBad = new URL(MODE === "rag" ? RAG_URL : MODE === "stream" ? STREAM_URL : ASK_URL);
  baseBad.hostname = "127.0.0.1";
  baseBad.port = "3999";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(baseBad.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: ctl.signal,
    });
    clearTimeout(timer);

    if (r.ok) throw new Error(`expected_fail_but_status_${r.status}`);
    console.log(`✔︎ Erreur réseau simulée OK (status=${r.status})`);
  } catch (e) {
    const code = e?.cause?.code || e?.code || e?.name || "n/a";
    console.log(`✔︎ Erreur réseau simulée OK (throw, code=${code})`);
  }

  if (stats.times.length) {
    const min = Math.min(...stats.times);
    const max = Math.max(...stats.times);
    const avg = Math.round(stats.times.reduce((a, b) => a + b, 0) / stats.times.length);
    console.log(`\nRésumé: ok=${stats.ok}, fails=${stats.fails}, min=${min}ms, avg=${avg}ms, max=${max}ms`);
  } else {
    console.log("\nAucune mesure de latence (tout en échec).");
  }
})();
