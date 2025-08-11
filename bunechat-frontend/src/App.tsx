// src/App.tsx
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import KbStatusBar from "./components/KbStatusBar";
import ActionBar from "./components/ActionBar";
import Modal from "./components/Modal";
import type { ChatMessage, Action, Evidence } from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3002";
const API_URL = `${API_BASE}/chatbot/ask`;
const STREAM_URL = `${API_BASE}/chatbot/ask/stream`;
const RAG_URL = `${API_BASE}/chatbot/ask/rag`;
const FILE_URL = `${API_BASE}/kb/file`;
const AGENT_URL = `${API_BASE}/chatbot/agent`;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// --- utils ---
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

function extractSources(text: string) {
  // détecte une ligne "Sources: a, b; c" et la retire du texte
  const re = /(^|\n)\s*Sources\s*:\s*([^\n]+)\s*$/i;
  const m = text.match(re);
  if (!m) return { text, sourcesFromText: [] as string[] };
  const sourcesRaw = m[2]
    .split(/[;,|]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const cleaned = text.replace(re, "").trimEnd();
  return { text: cleaned, sourcesFromText: uniq(sourcesRaw) };
}

function mapAgentActions(arr: any[]): Action[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((a: any, i: number) => {
      switch (a.tool) {
        case "show_file":
          return {
            id: `agent-${i}`,
            type: "show_file",
            label: `Voir ${a.args?.source || "fichier"}`,
            payload: { source: a.args?.source || "" },
          };
        case "propose_fix":
          return {
            id: `agent-${i}`,
            type: "propose_fix",
            label: `Fix ${a.args?.topic || ""}`,
            payload: { topic: a.args?.topic || "" },
          };
        case "ask_followup":
          return {
            id: `agent-${i}`,
            type: "ask_followup",
            label: a.result || a.args?.suggestion || "Question suivante",
            payload: { suggestion: a.result || a.args?.suggestion || "" },
          };
        default:
          return null;
      }
    })
    .filter(Boolean) as Action[];
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Bonjour 👋 Que puis-je faire pour ton projet BUNEC ?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [lastSources, setLastSources] = useState<string[]>([]);
  const [lastEvidence, setLastEvidence] = useState<Evidence[]>([]);
  const [mode, setMode] = useState("—");

  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Modal lecture de fichiers (Phase C)
  const [modal, setModal] = useState({ open: false, title: "", content: "" });
  const openModal = (title: string, content: string) =>
    setModal({ open: true, title, content });
  const closeModal = () => setModal({ open: false, title: "", content: "" });

  // ---- Typewriter (stream & RAG typewriter) ----
  const queueRef = useRef<string[]>([]); // file des caractères à afficher
  const rafRef = useRef<number | null>(null);
  const speedRef = useRef<number>(3); // nb de caractères par frame (1..8)

  useEffect(() => {
    boxRef.current?.scrollTo({
      top: boxRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const tick = () => {
    for (let i = 0; i < speedRef.current; i++) {
      const ch = queueRef.current.shift();
      if (ch == null) break;
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1] || {
          role: "assistant",
          content: "",
        };
        copy[copy.length - 1] = {
          role: "assistant",
          content: (last.content || "") + ch,
          actions: (last as ChatMessage).actions,
        };
        return copy;
      });
    }
    if (queueRef.current.length > 0) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
    }
  };
  const startTyping = () => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
  };
  const stopTyping = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // ---- Helpers UI ----
  const pushUser = (content: string) =>
    setMessages((prev) => [...prev, { role: "user", content }]);
  const pushAssistant = (content: string, actions: Action[] = []) =>
    setMessages((prev) => [...prev, { role: "assistant", content, actions }]);
  const resetSources = () => setLastSources([]);
  const resetEvidence = () => setLastEvidence([]);

  const guard = () => {
    const content = input.trim();
    if (!content || loading) return null;
    return content;
  };

  // ---- Actions Phase C ----
  const handleProposeFix = async (
    a: Extract<Action, { type: "propose_fix" }>
  ) => {
    const prompt = `À partir du contexte précédent, génère un correctif étape par étape pour ${a.payload.topic}.`;
    const next = [...messages, { role: "user", content: prompt } as ChatMessage];
    pushUser(a.label);
    setLoading(true);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      const data = await res.json().catch(() => ({}));
      pushAssistant(data.reply || "Désolé, pas de réponse.");
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur réseau/serveur."));
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (a: Action) => {
    if (a.type === "show_file") {
      openModal(a.payload.source, "Chargement…");
      try {
        const res = await fetch(
          `${FILE_URL}?source=${encodeURIComponent(a.payload.source)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP_${res.status}`);
        openModal(a.payload.source, data.content || "Fichier vide.");
      } catch (err: any) {
        openModal(a.payload.source, String(err?.message || "Erreur fichier."));
      }
      return;
    } else if (a.type === "propose_fix") {
      await handleProposeFix(a);
    } else if (a.type === "ask_followup") {
      setInput(a.payload.suggestion);
      inputRef.current?.focus();
    }
  };

  // ---- LLM simple (non stream) ----
  const sendAsk = async (e?: FormEvent) => {
    e?.preventDefault?.();
    const content = guard();
    if (!content) return;

    setMode("ASK");
    resetSources();
    resetEvidence();
    const next = [...messages, { role: "user", content } as ChatMessage];
    setMessages(next);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const started = performance.now();

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: next }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let msg = `HTTP_${res.status}`;
        try {
          const data = await res.json();
          if (data?.error === "quota_exceeded") {
            const sec = data?.retryAfterSec ?? null;
            msg = `⏳ Quota Gemini dépassé${
              sec ? ` (réessaie dans ~${sec}s)` : ""
            }.`;
          } else if (data?.hint || data?.error) {
            msg = `⚠️ ${data.error}${data.hint ? " — " + data.hint : ""}`;
          }
        } catch {}
        throw new Error(msg);
      }

      const data = await res.json();
      pushAssistant(data.reply || "Désolé, pas de réponse.");
      setLastLatency(Math.round(performance.now() - started));
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur réseau/serveur."));
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  // ---- LLM stream SSE (mot-à-mot) ----
  const sendAskStream = async (e?: FormEvent) => {
    e?.preventDefault?.();
    const content = guard();
    if (!content) return;

    setMode("STREAM");
    resetSources();
    resetEvidence();
    const next = [...messages, { role: "user", content } as ChatMessage];
    setMessages(next);
    setInput("");
    setLoading(true);

    const started = performance.now();
    stopTyping();
    queueRef.current = [];

    try {
      const res = await fetch(STREAM_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) throw new Error("HTTP_" + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantInserted = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        for (const line of chunk.split("\n")) {
          if (!line) continue;
          if (line.startsWith(":")) continue; // heartbeat
          if (!line.startsWith("data:")) continue;

          const raw = line.slice(5).trim();
          if (!raw) continue;

          try {
            const payload = JSON.parse(raw);

            if (!assistantInserted) {
              pushAssistant("");
              assistantInserted = true;
            }

            if (payload.error === "quota_exceeded") {
              pushAssistant("⏳ Quota Gemini dépassé. Réessaie un peu plus tard.");
              break;
            }
            if (payload.error === "timeout" || payload.error === "LLM_error") {
              pushAssistant("⚠️ Erreur serveur/timeout (stream).");
              break;
            }

            if (payload.delta) {
              for (const ch of payload.delta as string)
                queueRef.current.push(ch);
              startTyping();
            }
          } catch {
            /* ignore non-JSON */
          }
        }
      }

      setLastLatency(Math.round(performance.now() - started));
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur réseau/serveur (stream)."));
    } finally {
      setLoading(false);
    }
  };

  // ---- RAG (réponse directe + sources + evidence) ----
  const sendRag = async (e?: FormEvent) => {
    e?.preventDefault?.();
    const content = guard();
    if (!content) return;

    setMode("RAG");
    const next = [...messages, { role: "user", content } as ChatMessage];
    setMessages(next);
    setInput("");
    setLoading(true);
    resetSources();
    resetEvidence();

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(RAG_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: next }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let msg = `HTTP_${res.status}`;
        try {
          const data = await res.json();
          if (data?.error === "quota_exceeded") {
            const sec = data?.retryAfterSec ?? null;
            msg = `⏳ Quota Gemini dépassé${
              sec ? ` (réessaie dans ~${sec}s)` : ""
            }.`;
          } else if (data?.hint || data?.error) {
            msg = `⚠️ ${data.error}${data.hint ? " — " + data.hint : ""}`;
          } else if (res.status === 404) {
            msg = "⚠️ Endpoint RAG inexistant (/chatbot/ask/rag)";
          }
        } catch {}
        throw new Error(msg);
      }

      const data = await res.json().catch(() => ({}));
      const rawReply = data?.reply || "Désolé, pas de réponse.";
      const { text, sourcesFromText } = extractSources(rawReply);
      const sourcesMeta = Array.isArray(data?.meta?.sources)
        ? (data.meta.sources as string[])
        : [];
      const evidence = Array.isArray(data?.meta?.evidence)
        ? (data.meta.evidence as Evidence[])
        : [];
      const actions = Array.isArray(data?.actions)
        ? (data.actions as Action[])
        : [];

      pushAssistant(text, actions); // <-- actions visibles sous la bulle
      setLastSources(uniq([...sourcesMeta, ...sourcesFromText]));
      setLastEvidence(evidence);
      setLastLatency(Math.round(performance.now() - started));
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur RAG."));
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  // ---- RAG mot-à-mot (typewriter client) + evidence ----
  const sendRagStream = async (e?: FormEvent) => {
    e?.preventDefault?.();
    const content = guard();
    if (!content) return;

    setMode("RAG • TYPEWRITER");
    const next = [...messages, { role: "user", content } as ChatMessage];
    setMessages(next);
    setInput("");
    setLoading(true);
    resetSources();
    resetEvidence();

    const started = performance.now();
    stopTyping();
    queueRef.current = [];

    try {
      const res = await fetch(RAG_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages: next }),
      });

      if (!res.ok) {
        let msg = `HTTP_${res.status}`;
        try {
          const data = await res.json();
          if (data?.error === "quota_exceeded") {
            const sec = data?.retryAfterSec ?? null;
            msg = `⏳ Quota Gemini dépassé${
              sec ? ` (réessaie dans ~${sec}s)` : ""
            }.`;
          } else if (data?.hint || data?.error) {
            msg = `⚠️ ${data.error}${data.hint ? " — " + data.hint : ""}`;
          } else if (res.status === 404) {
            msg = "⚠️ Endpoint RAG inexistant (/chatbot/ask/rag)";
          }
        } catch {}
        throw new Error(msg);
      }

      const data = await res.json().catch(() => ({}));
      const rawReply = data?.reply || "Désolé, pas de réponse.";
      const { text, sourcesFromText } = extractSources(rawReply);
      const sourcesMeta = Array.isArray(data?.meta?.sources)
        ? (data.meta.sources as string[])
        : [];
      const evidence = Array.isArray(data?.meta?.evidence)
        ? (data.meta.evidence as Evidence[])
        : [];
      const actions = Array.isArray(data?.actions)
        ? (data.actions as Action[])
        : [];

      setLastSources(uniq([...sourcesMeta, ...sourcesFromText]));
      setLastEvidence(evidence);

      // Affichage caractère par caractère + actions
      pushAssistant("", actions);
      for (const ch of text as string) queueRef.current.push(ch);
      startTyping();

      setLastLatency(Math.round(performance.now() - started));
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur RAG (typewriter)."));
    } finally {
      setLoading(false);
    }
  };

  const sendAgent = async (e?: FormEvent) => {
    e?.preventDefault?.();
    const content = guard();
    if (!content) return;

    setMode("AGENT");
    resetSources();
    resetEvidence();
    const next = [...messages, { role: "user", content } as ChatMessage];
    setMessages(next);
    setInput("");
    setLoading(true);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(AGENT_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ question: content }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let msg = `HTTP_${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) msg = `⚠️ ${data.error}`;
        } catch {}
        throw new Error(msg);
      }

      const data = await res.json().catch(() => ({}));
      const actions = mapAgentActions(data?.actions);
      pushAssistant(data?.reply || "Désolé, pas de réponse.", actions);
      setLastLatency(Math.round(performance.now() - started));
    } catch (err: any) {
      pushAssistant(String(err?.message || "⚠️ Erreur agent."));
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  // ---- UI ----
  const clearChat = () => {
    stopTyping();
    setMessages([
      { role: "assistant", content: "Nouveau chat — que puis-je faire ?" },
    ]);
    setLastLatency(null);
    setLastSources([]);
    setLastEvidence([]);
    setMode("—");
  };

  const fmtScore = (s: string | number) => {
    const v = typeof s === "string" ? parseFloat(s) : s;
    if (Number.isNaN(v)) return String(s);
    return v.toFixed(3);
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 style={styles.h1}>Chatbot BUNEC — Phase B (RAG “light”)</h1>
          <div style={styles.pill}>{mode}</div>
        </div>

        <KbStatusBar />

        <div style={styles.meta}>
          <span>
            Routes: <code>/chatbot/ask</code> • <code>/chatbot/ask/stream</code>{" "}
            • <code>/chatbot/ask/rag</code>
          </span>
          {lastLatency != null && (
            <span>Dernière latence: {lastLatency} ms</span>
          )}
          <span>
            {" "}
            | Vitesse:&nbsp;
            <input
              type="range"
              min={1}
              max={8}
              defaultValue={3}
              onChange={(e) => (speedRef.current = Number(e.target.value))}
              title="Vitesse d'affichage (stream/typewriter)"
            />
          </span>
        </div>

        <div ref={boxRef} style={styles.chatBox}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.msg,
                ...(m.role === "user" ? styles.user : styles.assistant),
              }}
            >
              <strong style={{ opacity: 0.8 }}>
                {m.role === "user" ? "Toi" : "Assistant"}
              </strong>
              <p style={styles.p}>{m.content}</p>

              {m.role === "assistant" &&
                m.actions &&
                m.actions.length > 0 && (
                  <ActionBar actions={m.actions} onAction={handleAction} disabled={loading} />
                )}
            </div>
          ))}
          {loading && (
            <div style={styles.typing}>Assistant est en train d'écrire…</div>
          )}
        </div>

        <form onSubmit={(e) => e.preventDefault()} style={styles.form}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Pose ta question…"
            style={styles.input}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendAskStream();
              else if (e.key === "Enter" && !e.shiftKey) sendAsk();
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={sendAsk}
              disabled={loading || !input.trim()}
              style={styles.btn}
            >
              Envoyer
            </button>
            <button
              onClick={sendAskStream}
              disabled={loading || !input.trim()}
              style={styles.btnAlt}
            >
              Stream
            </button>
            <button
              onClick={sendRag}
              disabled={loading || !input.trim()}
              style={styles.btnRag}
            >
              RAG
            </button>
            <button
              onClick={sendRagStream}
              disabled={loading || !input.trim()}
              style={styles.btnRag2}
            >
              RAG (mot-à-mot)
            </button>
            <button
              onClick={sendAgent}
              disabled={loading || !input.trim()}
              style={styles.btnAgent}
            >
              Agent
            </button>
            <button onClick={clearChat} disabled={loading} style={styles.btnGhost}>
              Effacer
            </button>
          </div>
        </form>

        {(lastSources.length > 0 || lastEvidence.length > 0) && (
          <div style={styles.sources}>
            {lastSources.length > 0 && (
              <>
                <div style={{ opacity: 0.8, marginBottom: 6 }}>
                  Sources utilisées :
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {lastSources.map((sname, i) => (
                    <li key={i}>
                      <code>{sname}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {lastEvidence.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ opacity: 0.8, marginBottom: 6 }}>
                  Extraits pertinents :
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {lastEvidence.map((e, i) => (
                    <li key={i} style={{ marginBottom: 6 }}>
                      <div>
                        <code>{e.source}</code> — score {fmtScore(e.score)}
                      </div>
                      <blockquote
                        style={{ margin: "6px 0 0 0", opacity: 0.9 }}
                      >
                        {e.preview}…
                      </blockquote>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <Modal open={modal.open} onClose={closeModal} title={modal.title}>
        {modal.content}
      </Modal>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "#0b1220",
  },
  card: {
    width: "min(920px, 94vw)",
    background: "#111827",
    color: "#e5e7eb",
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 10px 30px rgba(0,0,0,.3)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pill: {
    background: "#0f172a",
    border: "1px solid #1f2937",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    opacity: 0.85,
  },
  h1: { margin: "6px 0 8px 0", fontSize: 20 },
  meta: {
    display: "flex",
    gap: 16,
    opacity: 0.8,
    fontSize: 12,
    marginBottom: 8,
    flexWrap: "wrap",
    alignItems: "center",
  },
  chatBox: {
    height: "64vh",
    overflowY: "auto",
    background: "#0f172a",
    borderRadius: 12,
    padding: 12,
    border: "1px solid #1f2937",
  },
  msg: { borderRadius: 12, padding: "10px 12px", margin: "10px 0" },
  user: { background: "#1f2937", textAlign: "right" },
  assistant: { background: "#111827" },
  p: { margin: "6px 0 0 0", whiteSpace: "pre-wrap" },
  typing: { opacity: 0.8, fontStyle: "italic", marginTop: 8 },
  form: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" },
  input: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    border: "1px solid #374151",
    background: "#0b1220",
    color: "#e5e7eb",
  },
  btn: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#2563eb",
    color: "white",
    cursor: "pointer",
  },
  btnAlt: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#16a34a",
    color: "white",
    cursor: "pointer",
  },
  btnRag: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#f59e0b",
    color: "#111827",
    cursor: "pointer",
  },
  btnRag2: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#f97316",
    color: "#111827",
    cursor: "pointer",
  },
  btnAgent: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#9333ea",
    color: "white",
    cursor: "pointer",
  },
  btnGhost: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid #374151",
    background: "transparent",
    color: "#e5e7eb",
    cursor: "pointer",
  },
  sources: {
    marginTop: 10,
    background: "#0f172a",
    border: "1px solid #1f2937",
    borderRadius: 12,
    padding: 10,
  },
};
