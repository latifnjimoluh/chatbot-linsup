import { ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export default function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      const text = typeof children === "string" ? children : "";
      if (text) await navigator.clipboard.writeText(text);
    } catch {}
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.7)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1f2937",
          color: "#e5e7eb",
          padding: 20,
          borderRadius: 12,
          width: "80vw",
          maxWidth: 800,
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 10px 30px rgba(0,0,0,.4)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: "bold" }}>{title}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={copy}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e5e7eb" }}
              title="Copier le contenu"
            >
              Copier
            </button>
            <button
              onClick={onClose}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e5e7eb" }}
            >
              Fermer
            </button>
          </div>
        </div>

        <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{children}</div>
      </div>
    </div>
  );
}
