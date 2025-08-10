import type { Action } from "../types";

interface Props {
  actions: Action[];
  onAction: (a: Action) => void;
}

export default function ActionBar({ actions, onAction }: Props) {
  if (!actions || actions.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {actions.map((a) => (
        <button
          key={a.id}
          onClick={() => onAction(a)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #374151",
            background: "#1f2937",
            color: "#e5e7eb",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
