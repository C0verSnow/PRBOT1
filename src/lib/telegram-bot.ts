import { openThread } from "./codex";
import { runtimeConfig } from "./config";
import { telegramCredentials } from "./infisical";
import { reserve } from "./runner";
import { readTelegramSettings } from "./telegram-settings";
import { TelegramStorage, type RedisCredentials, type TelegramRecord } from "./telegram-storage";

type Update = { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { id: number; username?: string; is_bot?: boolean } } };
const state = globalThis as typeof globalThis & { prbotTelegramStarted?: boolean };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function telegram<T>(token: string, method: string, data: object): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Telegram 请求失败");
  const value = await response.json() as { ok: boolean; result: T };
  if (!value.ok) throw new Error("Telegram 请求失败");
  return value.result;
}
async function send(token: string, chatId: string, text: string) {
  const chunks = Array.from(text || "（没有文字回复）");
  while (chunks.length) await telegram(token, "sendMessage", { chat_id: chatId, text: chunks.splice(0, 4000).join("") });
}
export async function handleTelegramUpdate(update: Update, credentials: RedisCredentials, settingsKey: string, allowed: string[]) {
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private" || !message.text || !allowed.includes(String(message.from.id))) return;
  const storage = new TelegramStorage(credentials);
  if (await storage.seen(update.update_id)) return;
  const current = await readTelegramSettings();
  if (!current?.enabled || JSON.stringify(current) !== settingsKey || !current.allowedUsers.split(",").map(x => x.trim()).includes(String(message.from.id))) return;
  const lock = reserve(`telegram:${message.from.id}`);
  const chatId = String(message.chat.id);
  try {
    const confirmed = await readTelegramSettings();
    if (!confirmed?.enabled || JSON.stringify(confirmed) !== settingsKey) return;
    const config = await runtimeConfig();
    const base = { userId: String(message.from.id), username: message.from.username, chatId, workspace: config.workspace };
    const record = (role: TelegramRecord["role"], text: string, threadId?: string, updateId?: number): TelegramRecord => ({ ...base, role, text, threadId, updateId, time: new Date().toISOString() });
    const previous = await storage.latest(base.userId, base.chatId, base.workspace);
    // Save the update before starting Codex: a restart must not execute the same request twice.
    await storage.append(record("user", message.text, previous?.threadId, update.update_id));
    if (message.text === "/start") { await send(credentials.botToken, base.chatId, "已连接。发送文字即可与 Codex 对话；发送 /new 开始新对话。"); return; }
    if (message.text === "/new") { await storage.append(record("system", "新对话")); await send(credentials.botToken, base.chatId, "已开始新对话，请发送任务。"); return; }
    const thread = await openThread(previous?.threadId);
    let threadId = previous?.threadId;
    let completed = false;
    const texts = new Map<string, string>();
    const signal = AbortSignal.any([lock.controller.signal, AbortSignal.timeout(30 * 60_000)]);
    const { events } = await thread.runStreamed(message.text, { signal });
    for await (const event of events) {
      if (event.type === "thread.started") { threadId = event.thread_id; await storage.append(record("system", "会话已创建", threadId)); }
      if ("item" in event && event.item.type === "agent_message") texts.set(event.item.id, event.item.text);
      if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex 任务失败");
      if (event.type === "turn.completed") completed = true;
    }
    if (!completed) throw new Error("Codex 任务中断");
    const answer = [...texts.values()].join("\n\n") || "（没有文字回复）";
    await storage.append(record("assistant", answer, threadId));
    await send(credentials.botToken, base.chatId, answer);
  } catch {
    await send(credentials.botToken, chatId, "任务未完成，请检查本机 Codex、网络和服务日志。已执行的操作不会自动撤销。").catch(() => {});
  } finally { lock.release(); }
}
export function startTelegramBot() {
  if (state.prbotTelegramStarted) return;
  state.prbotTelegramStarted = true;
  void (async () => {
    let offset = 0; let cachedKey = ""; let credentials: RedisCredentials | undefined; let expires = 0;
    for (;;) {
      try {
        const settings = await readTelegramSettings();
        if (!settings?.enabled) { cachedKey = ""; credentials = undefined; offset = 0; await pause(5000); continue; }
        const key = JSON.stringify(settings);
        if (!credentials || key !== cachedKey || Date.now() >= expires) {
          const refreshed = await telegramCredentials(settings);
          if (credentials && refreshed.botToken !== credentials.botToken) offset = 0;
          credentials = refreshed; cachedKey = key; expires = Date.now() + 60000;
        }
        const updates = await telegram<Update[]>(credentials.botToken, "getUpdates", { offset, limit: 1, timeout: 10, allowed_updates: ["message"] });
        for (const update of updates) {
          await handleTelegramUpdate(update, credentials, key, settings.allowedUsers.split(",").map(x => x.trim()));
          offset = update.update_id + 1;
        }
      } catch (e) {
        console.error("Telegram Bot 暂时不可用:", e instanceof Error ? e.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[已隐藏]") : "未知错误");
        await pause(5000);
      }
    }
  })();
}
