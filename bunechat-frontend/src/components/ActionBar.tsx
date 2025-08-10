import type { Action } from "../types";

interface Props {
  actions: Action[];
  onAction: (a: Action) => void;
  disabled?: boolean;
}

export default function ActionBar({ actions, onAction, disabled }: Props) {
  if (!actions || actions.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {actions.map((a) => (
        <button
          key={a.id}
          onClick={() => !disabled && onAction(a)}
          disabled={disabled}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #374151",
            background: disabled ? "#111827" : "#1f2937",
            color: "#e5e7eb",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 13,
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
