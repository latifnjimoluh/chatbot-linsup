export type Action =
  | { id: string; type: "show_file";   label: string; payload: { source: string } }
  | { id: string; type: "propose_fix"; label: string; payload: { topic: string } }
  | { id: string; type: "ask_followup"; label: string; payload: { suggestion: string } };

export interface ChatMessage { role: "user" | "assistant"; content: string; actions?: Action[] }
