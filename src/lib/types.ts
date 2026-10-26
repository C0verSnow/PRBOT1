export interface Activity {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status?: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  activities: Activity[];
  status: "running" | "completed" | "failed" | "stopped";
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  threadId?: string;
  messages: Message[];
}
export type ChatSummary = Pick<Chat, "id" | "title" | "updatedAt">;
export interface PublicConfig { workspace: string; model: string; access: "danger-full-access" }
export type StreamEvent = { type: "snapshot"; chat: Chat } | { type: "error"; message: string };
