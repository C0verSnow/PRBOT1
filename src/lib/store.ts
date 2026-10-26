import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { HttpError } from "./http";
import type { Chat, ChatSummary } from "./types";

function filename(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "找不到这段对话");
  return path.join(dataDirectory(), `${id}.json`);
}
export async function saveChat(chat: Chat) {
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  const target = filename(chat.id); const tmp = `${target}.${randomUUID()}.tmp`;
  chat.updatedAt = new Date().toISOString();
  try {
    await writeFile(tmp, JSON.stringify(chat), { mode: 0o600 });
    await rename(tmp, target);
  } finally { await unlink(tmp).catch(() => {}); }
}
export async function getChat(id: string): Promise<Chat> {
  try { return JSON.parse(await readFile(filename(id), "utf8")) as Chat; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "找不到这段对话");
    throw e;
  }
}
export async function createChat() {
  const chat: Chat = { id: randomUUID(), title: "新对话", updatedAt: new Date().toISOString(), messages: [] };
  await saveChat(chat); return chat;
}
export async function listChats(): Promise<ChatSummary[]> {
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  const summaries: ChatSummary[] = [];
  for (const file of await readdir(dataDirectory())) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const { id, title, updatedAt } = await getChat(file.slice(0, -5));
    summaries.push({ id, title, updatedAt });
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function deleteChat(id: string) {
  await getChat(id); await unlink(filename(id));
}
