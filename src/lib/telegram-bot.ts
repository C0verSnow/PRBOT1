import { runtimeConfig } from "./config";
import { telegramCredentials } from "./infisical";
import { telegramRequest, telegramSend } from "./telegram-api";
import { redactTelegram, secretsFromEnv } from "./telegram-redact";
import { readTelegramSettings, type TelegramSettings } from "./telegram-settings";
import { TelegramTaskStore, type TelegramTask } from "./telegram-task-store";
import type { RedisCredentials } from "./telegram-storage";
import { dispatchTelegram, recoverTelegramTasks } from "./telegram-worker";

type Person = { id: number; username?: string; is_bot?: boolean };
type Message = { text?: string; chat: { id: number; type: string }; from?: Person };
export type TelegramUpdate = {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; data?: string; from: Person; message?: Message };
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const personShape = (value: unknown) => object(value) && Number.isSafeInteger(value.id) && (value.is_bot === undefined || typeof value.is_bot === "boolean");
function messageShape(value: unknown) {
  return object(value) && object(value.chat) && Number.isSafeInteger(value.chat.id) && typeof value.chat.type === "string"
    && (value.from === undefined || personShape(value.from)) && (value.text === undefined || typeof value.text === "string");
}
/** Validate nested fields before using an authenticated but still untrusted webhook payload. */
export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!object(value) || !Number.isSafeInteger(value.update_id) || Number(value.update_id) < 0) return false;
  if (value.message !== undefined && !messageShape(value.message)) return false;
  if (value.callback_query !== undefined) {
    const callback = value.callback_query;
    if (!object(callback) || typeof callback.id !== "string" || !callback.id || callback.id.length > 256 || !personShape(callback.from)) return false;
    if (callback.data !== undefined && (typeof callback.data !== "string" || Buffer.byteLength(callback.data, "utf8") > 64)) return false;
    if (callback.message !== undefined && !messageShape(callback.message)) return false;
  }
  return true;
}
type Command = { name: string; argument: string };
type Connection = { credentials: RedisCredentials; settings: TelegramSettings; key: string; expires: number };
const state = globalThis as typeof globalThis & {
  prbotTelegramStarted?: boolean;
  prbotTelegramIntake?: Map<string, Promise<unknown>>;
  prbotTelegramConnection?: Connection;
};
const intake = state.prbotTelegramIntake ??= new Map<string, Promise<unknown>>();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const help = [
  "PRBOT 指令（忽略大小写）：",
  "/start  检查连接与当前工作空间",
  "/help  查看帮助",
  "/id  查看你的 Telegram ID",
  "/FinishIssue  输入 GitHub Issue 链接并确认任务",
  "/status  查看当前任务与待回复问题",
  "/logs [游标]  分页查看执行日志；按回复中的游标接着看",
  "/tasks  查看当前工作空间最近的任务",
  "/cancel  退出当前交互或请求停止任务",
  "/continue  检查并继续此前任务或对话",
  "/new  开启新的 Codex 会话",
  "/confirm 问题编号  确认当前问题（也可点击按钮）",
  "直接发送文字即可继续对话；执行中的补充要求会排队进入同一任务。",
].join("\n");

export function parseTelegramCommand(text: string): Command | undefined {
  const value = text.trim();
  const slash = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(value);
  if (slash) return { name: slash[1].toLowerCase(), argument: (slash[2] || "").trim() };
  const alias = /^(finish\s+issue|help|id|cancel)(?:\s+([\s\S]*))?$/i.exec(value);
  if (alias) return { name: alias[1].toLowerCase().replace(/\s+/g, ""), argument: (alias[2] || "").trim() };
}

function status(task?: TelegramTask) {
  if (!task) return "当前没有任务。发送文字开始对话，或使用 /FinishIssue。";
  return [
    `任务：${task.id}`, `状态：${task.status}`, task.stage && `进度：${task.stage}`,
    task.threadId && `Codex 会话：${task.threadId}`, task.issue && `Issue：${task.issue.url}`,
    task.branch && `分支：${task.branch}`, task.prUrl && `PR：${task.prUrl}`,
    task.question && `等待回复：${task.question.text}\n问题编号：${task.question.id}${task.question.highRisk ? `\n请点击确认按钮或发送 /confirm ${task.question.id}；/cancel 取消。` : "\n直接回复即可继续。"}`,
    task.error && `提示：${task.error}`,
    ["failed", "interrupted", "cancelled"].includes(task.status) && "使用 /continue 检查后继续；已完成的文件操作不会自动撤销。",
  ].filter(Boolean).join("\n");
}

async function serialized<T>(key: string, action: () => Promise<T>) {
  const previous = intake.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  intake.set(key, next);
  try { return await next; }
  finally { if (intake.get(key) === next) intake.delete(key); }
}

export async function telegramConnection(): Promise<Connection | undefined> {
  const settings = await readTelegramSettings();
  if (!settings?.enabled) { state.prbotTelegramConnection = undefined; return; }
  const key = JSON.stringify(settings);
  if (state.prbotTelegramConnection?.key === key && state.prbotTelegramConnection.expires > Date.now()) return state.prbotTelegramConnection;
  const credentials = await telegramCredentials(settings);
  return state.prbotTelegramConnection = { credentials, settings, key, expires: Date.now() + 60_000 };
}

/** Intake awaits only durable state changes. Codex runs independently in the worker. */
export async function handleTelegramUpdate(update: TelegramUpdate, credentials: RedisCredentials, settingsKey: string, allowed: string[], options: { waitForReply?: boolean } = {}) {
  if (!isTelegramUpdate(update)) return;
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const person = callback?.from || message?.from;
  if (!message || !person || person.is_bot || message.chat?.type !== "private" || !Number.isSafeInteger(person.id) || !Number.isSafeInteger(message.chat.id) || !allowed.includes(String(person.id))) return;
  const selected = callback ? /^(confirm|cancel):([A-Za-z0-9_-]{1,100})$/.exec(callback.data || "") : undefined;
  if (callback && !selected) return;
  if (!callback && (typeof message.text !== "string" || !message.text.trim())) return;
  const userId = String(person.id); const chatId = String(message.chat.id);
  await serialized(`${credentials.botToken.split(":")[0]}:${userId}:${chatId}`, async () => {
    const current = await readTelegramSettings();
    if (!current?.enabled || JSON.stringify(current) !== settingsKey || !current.allowedUsers.split(",").map(value => value.trim()).includes(userId)) return;
    const config = await runtimeConfig();
    const secrets = [current.clientSecret, ...secretsFromEnv(config.env || {}), ...secretsFromEnv(process.env)];
    const storage = new TelegramTaskStore(credentials, secrets);
    if (!await storage.claimUpdate(update.update_id)) return;
    const send = async (text: string) => telegramSend(credentials, chatId, redactTelegram(text, secrets));
    const reply = (text: string) => {
      const sent = send(text);
      if (options.waitForReply === false) { void sent.catch(() => {}); return Promise.resolve(); }
      return sent;
    };
    try {
      if (callback) {
        // Callback ownership is checked by the worker against the current session/question.
        const acknowledged = telegramRequest(credentials.botToken, "answerCallbackQuery", { callback_query_id: callback.id });
        if (options.waitForReply === false) void acknowledged.catch(() => {});
        else await acknowledged.catch(() => {});
      }
      const command = selected ? { name: selected[1], argument: selected[2] } : parseTelegramCommand(message.text || "");
      if (command?.name === "help") { await reply(help); return; }
      if (command?.name === "id") { await reply(`你的 Telegram ID：${userId}\n当前用户已通过授权验证。`); return; }
      if (command?.name === "start") {
        await reply(`欢迎使用 PRBOT。\n当前连接状态：已连接\nCodex 状态：已配置（执行时检查登录与模型权限）\n工作空间：${config.workspace}\n输入 /help 查看可用命令。`); return;
      }
      if (command && ["status", "tasks", "logs"].includes(command.name)) {
        const session = await storage.loadSession(userId, chatId, config.workspace);
        const currentTask = session.taskId ? await storage.loadTask(session.taskId) : undefined;
        const task = currentTask?.userId === userId && currentTask.chatId === chatId && currentTask.workspace === config.workspace ? currentTask : undefined;
        if (command.name === "status") {
          await reply(session.awaitingIssue ? "正在等待 GitHub Issue 链接。发送 /cancel 退出。" : status(task)); return;
        }
        if (command.name === "tasks") {
          const tasks = await storage.listTasks(userId, chatId, config.workspace);
          await reply(tasks.length ? tasks.slice(0, 10).map(item => `${item.id} · ${item.status}\n${item.issue?.url || item.stage || item.kind}`).join("\n\n") : "当前工作空间还没有任务。"); return;
        }
        if (!task) { await reply("当前没有任务日志。"); return; }
        const cursor = command.argument || "0-0";
        if (!/^\d+-\d+$/.test(cursor)) { await reply("日志游标格式不正确。请使用 /logs 或 /logs 123456789-0。"); return; }
        const page = await storage.events(task.id, cursor, 5);
        const text = page.events.map(event => `[${event.id}] ${event.text}`).join("\n\n");
        await reply(`${text || "这个游标之后暂时没有日志；日志缓存可能已经过期。"}\n\n接着查看：/logs ${page.nextCursor}`); return;
      }
      const actions = ["new", "continue", "cancel", "confirm", "finishissue"] as const;
      const action = command && actions.find(item => item === command.name);
      if (command && !action) { await reply("没有这个指令。输入 /help 查看支持的指令。"); return; }
      if (action === "confirm" && !/^[A-Za-z0-9_-]{1,100}$/.test(command!.argument)) { await reply("请使用 /confirm 问题编号，或点击当前问题的确认按钮。"); return; }
      const answer = await dispatchTelegram({
        text: action ? command!.argument : message.text!, userId, chatId, workspace: config.workspace,
        credentials, settingsKey, action: action || "message",
        ...(selected || action === "confirm" ? { questionId: command!.argument } : {}),
      });
      await reply(answer);
    } catch (error) {
      const detail = redactTelegram(error instanceof Error ? error.message : "未知错误", secrets).slice(0, 1200);
      await reply(`本次操作未完成：${detail}\n请用 /status 检查任务；如果没有创建任务，请重新发送。已完成的文件操作不会自动撤销。`).catch(() => {});
      // A webhook must not acknowledge failed intake as accepted. Telegram can retry it.
      if (options.waitForReply === false) throw new Error(detail);
    }
  });
}

export function startTelegramBot() {
  if (state.prbotTelegramStarted) return;
  state.prbotTelegramStarted = true;
  void (async () => {
    let offset = 0; let botId = ""; let recoveredKey = "";
    for (;;) {
      try {
        const connection = await telegramConnection();
        if (!connection) { offset = 0; botId = ""; recoveredKey = ""; await pause(5000); continue; }
        const { credentials, settings, key } = connection;
        const nextBotId = credentials.botToken.split(":")[0];
        if (botId !== nextBotId) { offset = 0; botId = nextBotId; }
        if (recoveredKey !== key) { await recoverTelegramTasks(credentials, key); recoveredKey = key; }
        // Webhook transport is opt-in. Keep the same durable worker/recovery process alive.
        if (process.env.PRBOT_TELEGRAM_TRANSPORT === "webhook") { await pause(5000); continue; }
        const updates = await telegramRequest<TelegramUpdate[]>(credentials.botToken, "getUpdates", { offset, limit: 20, timeout: 10, allowed_updates: ["message", "callback_query"] });
        for (const update of updates) {
          await handleTelegramUpdate(update, credentials, key, settings.allowedUsers.split(",").map(value => value.trim()), { waitForReply: false });
          offset = update.update_id + 1;
        }
      } catch {
        console.error("Telegram Bot 暂时不可用，请检查本机配置、网络和服务日志。");
        await pause(5000);
      }
    }
  })();
}
