import { useEffect, useState, type CSSProperties } from "react";

type KbEnv = {
  RAG_TOP_K?: number;
  RAG_MIN_SCORE?: number | null;
  RAG_QVARIANTS?: number;
  RAG_ARBITER?: string;
  SEARCH_BACKEND?: string;
  VECTOR_DIR?: string;
};

type KbStats = {
  backend?: string;
  model?: string;
  dim?: number;
  docs?: number;
  vectors?: number;
  createdAt?: string;
  path?: string;
};

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3002";
const KB_STATS_URL  = `${API_BASE}/kb/stats`;
const KB_RELOAD_URL = `${API_BASE}/kb/reload`;

function timeAgo(iso?: string) {
  if (!iso) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}j`;
}

export default function KbStatusBar() {
  const [backend, setBackend] = useState<string>("?");
  const [env, setEnv] = useState<KbEnv>({});
  const [stats, setStats] = useState<KbStats>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justReloaded, setJustReloaded] = useState(false);

  const normalize = (j: any) => {
    const rawStats = j?.stats || j || {};
    const st: KbStats = {
      backend: j?.backend || rawStats.backend || rawStats.name || j?.SEARCH_BACKEND,
      model: rawStats.model || rawStats.embedModel || undefined,
      dim: rawStats.dim ?? rawStats.dimension ?? undefined,
      docs: rawStats.docs ?? rawStats.docCount ?? undefined,
      vectors: rawStats.vectors ?? rawStats.vectorCount ?? undefined,
      createdAt: rawStats.createdAt || rawStats.indexCreatedAt || undefined,
      path: rawStats.path || undefined,
    };
    const ev: KbEnv = j?.env || {};
    const be = st.backend || "json";
    return { backend: be, env: ev, stats: st };
  };

  const fetchStats = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(KB_STATS_URL);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP_${r.status}`);
      const n = normalize(j);
      setBackend(n.backend); setEnv(n.env); setStats(n.stats);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setLoading(false); }
  };

  const reloadKb = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(KB_RELOAD_URL, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP_${r.status}`);
      const n = normalize(j);
      setBackend(n.backend); setEnv(n.env); setStats(n.stats);
      setJustReloaded(true); setTimeout(() => setJustReloaded(false), 2000);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchStats(); }, []);

  const ok = !!stats.model && !!stats.dim && typeof stats.docs === "number";

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <span title={ok ? "Index chargé" : "Index indisponible"} style={{ ...styles.dot, background: loading ? "#f59e0b" : ok ? "#16a34a" : "#ef4444" }} />
        <span style={styles.kv}><strong>KB</strong>: {backend}</span>
        <span style={styles.sep}>•</span>
        <span style={styles.kv}><strong>modèle</strong>: {stats.model || "—"}</span>
        <span style={styles.sep}>•</span>
        <span style={styles.kv}><strong>dim</strong>: {stats.dim ?? "—"}</span>
        <span style={styles.sep}>•</span>
        <span style={styles.kv}><strong>docs</strong>: {stats.docs ?? "—"}</span>
        <span style={styles.sep}>•</span>
        <span style={styles.kv}><strong>vecteurs</strong>: {stats.vectors ?? "—"}</span>
        <span style={styles.sep}>•</span>
        <span style={styles.kv}><strong>âge</strong>: {timeAgo(stats.createdAt)}</span>
        {stats.path && <span style={{ ...styles.sep, opacity:.6 }}>•</span>}
        {stats.path && <span title={stats.path} style={{ ...styles.kv, opacity:.75 }}><strong>fichier</strong>: <code>{(stats.path.split(/[\\/]/).pop() || "index.json")}</code></span>}
      </div>

      <div style={styles.right}>
        <span style={{ ...styles.env }}>
          k={env.RAG_TOP_K ?? "—"} | min={env.RAG_MIN_SCORE ?? "—"} | var={env.RAG_QVARIANTS ?? "—"}
        </span>
        <button onClick={fetchStats} disabled={loading} style={styles.btnGhost} title="Actualiser">
          {loading ? "…" : "Actualiser"}
        </button>
        <button onClick={reloadKb} disabled={loading} style={styles.btn}>
          {justReloaded ? "Rechargée ✓" : "Recharger KB"}
        </button>
      </div>

      {err && <div style={styles.err} title={err}>⚠️ {err}</div>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  bar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderRadius: 10, border: "1px solid #1f2937", background: "#0f172a", margin: "10px 0" },
  left: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  right: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 999, display: "inline-block" },
  kv: { fontSize: 12, opacity: .9 },
  sep: { opacity: .4 },
  env: { fontSize: 12, opacity: .85, marginRight: 4 },
  btn: { padding: "8px 12px", borderRadius: 8, border: "none", background: "#2563eb", color: "white", cursor: "pointer" },
  btnGhost: { padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", cursor: "pointer" },
  err: { marginLeft: 8, fontSize: 12, color: "#fca5a5" },
};
