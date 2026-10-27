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
  workspace?: string;
  messages: Message[];
}
export type ChatSummary = Pick<Chat, "id" | "title" | "updatedAt">;
export interface AppSettings { workspace: string; model: string; codexPath: string; codexHome: string; recentWorkspaces: string[]; effort?: string; speed?: string }
export interface PublicConfig extends Omit<AppSettings, "model"> { model: string; modelId: string; access: "danger-full-access" }
export interface CodexModel { id: string; name: string; isDefault: boolean; efforts: string[]; defaultEffort: string; speeds: { id: string; name: string }[]; defaultSpeed: string }
declare global { interface Window { prbotDesktop?: { chooseWorkspace: () => Promise<string | null> } } }
export type StreamEvent = { type: "snapshot"; chat: Chat } | { type: "error"; message: string };
