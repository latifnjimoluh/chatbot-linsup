import { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export default function Modal({ open, onClose, title, children }: ModalProps) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
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
          maxWidth: 600,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        <div style={{ fontWeight: "bold", marginBottom: 10 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{children}</div>
        <button
          onClick={onClose}
          style={{ marginTop: 16, padding: "6px 12px", border: "1px solid #374151", background: "#111827", color: "#e5e7eb", borderRadius: 8 }}
        >
          Fermer
        </button>
      </div>
    </div>
  );
}
