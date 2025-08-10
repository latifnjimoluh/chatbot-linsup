import type { Action } from "../types";

interface Props {
  actions: Action[];
  onAction: (a: Action) => void | Promise<void>;
  busyId?: string | null;
}

const icon: Record<Action["type"], string> = {
  show_file: "📄",
  propose_fix: "🩹",
  ask_followup: "💬",
};

export default function ActionBar({ actions, onAction, busyId }: Props) {
  if (!actions || actions.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {actions.map((a) => {
        const busy = busyId === a.id;
        return (
          <button
            key={a.id}
            onClick={() => onAction(a)}
            disabled={busy}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: busy ? "#111827" : "#1f2937",
              color: "#e5e7eb",
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: busy ? 0.7 : 1,
            }}
            title={a.label}
          >
            <span>{icon[a.type]}</span>
            <span>{busy ? "…" : a.label}</span>
          </button>
        );
      })}
    </div>
  );
}
