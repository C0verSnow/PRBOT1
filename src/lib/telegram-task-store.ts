import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirectory } from "./config";
import { redactTelegram } from "./telegram-redact";
import type { RedisCredentials } from "./telegram-storage";

export type TelegramTaskStatus = "queued" | "running" | "waiting_input" | "awaiting_review" | "completed" | "failed" | "cancelled" | "interrupted";
export type TelegramIssue = { owner: string; repo: string; number: number; url: string; title?: string; baseBranch?: string; context?: string; closePolicy?: "after_ci" | "keep_open" };
export type TelegramQuestion = { id: string; text: string; choices?: string[]; highRisk?: boolean };
export type TelegramTask = {
  id: string; userId: string; chatId: string; workspace: string; kind: "chat" | "issue";
  repositoryPath?: string; failedStage?: string;
  threadId?: string; status: TelegramTaskStatus; prompt: string; pending: string[];
  createdAt: string; updatedAt: string; stage?: string; issue?: TelegramIssue;
  question?: TelegramQuestion; branch?: string; prUrl?: string; error?: string;
  cancelRequested?: boolean; runner?: { pid: number; host: string; startedAt: string };
  baseSha?: string; commitSha?: string; publishTree?: string;
  instructions?: import("./telegram-instructions").InstructionEvidence[];
  acceptance?: { phase: "implementation" | "delivery"; requirement: string; verified: boolean; evidence: string }[];
  documentation?: string; changedFiles?: string[];
  deliveryPhase?: "publishing" | "waiting_ci" | "closing_issue";
  ci?: { state: "pending" | "passed" | "failed" | "missing"; sha: string; summary: string; urls: string[]; checkedAt: string };
  issueState?: "open" | "closed";
  lastEventId?: string; [key: string]: unknown;
};
export type TelegramSession = {
  userId: string; chatId: string; workspace: string; threadId?: string; taskId?: string;
  awaitingIssue?: boolean; pendingIssue?: TelegramIssue; updatedAt: string; [key: string]: unknown;
};
export type TelegramEvent = { id: string; text: string };
const LOG_LIMIT = 50 * 1024 * 1024;
const EVENT_LIMIT = 16_000;
const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CURSOR = /^\d+-\d+$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// These fields are validated machine identities, not message content. Redacting a short
// credential substring here could corrupt a status, pathname or a resumable thread ID.
const identityFields = new Set(["id", "userId", "chatId", "workspace", "repositoryPath", "kind", "status", "createdAt", "updatedAt", "threadId", "taskId", "host", "startedAt", "owner", "repo", "url", "baseBranch", "branch", "prUrl", "lastEventId", "baseSha", "commitSha", "sha", "sha256", "readAt", "closePolicy", "deliveryPhase", "issueState"]);
const statuses: TelegramTaskStatus[] = ["queued", "running", "waiting_input", "awaiting_review", "completed", "failed", "cancelled", "interrupted"];

// Borrowed designs: Redis Streams cursors + compare-and-delete leases, not a new queue
// framework. Primary references and tradeoffs are recorded in docs/issue-14-research.md.
export const TELEGRAM_APPEND_EVENT = `
local streamType = redis.call('TYPE', KEYS[1]).ok
local indexType = redis.call('TYPE', KEYS[2]).ok
if (streamType ~= 'none' and streamType ~= 'stream') or (indexType ~= 'none' and indexType ~= 'list') then
  return redis.error_reply('Telegram log cache has an invalid key type')
end
local rawSize = redis.call('GET', KEYS[3])
local size = tonumber(rawSize or '0')
local length = redis.call('LLEN', KEYS[2])
if not size or size < 0 or (not rawSize and length > 0) or (size == 0 and length > 0) or (size > 0 and length == 0) or (not rawSize and streamType ~= 'none') then
  return redis.error_reply('Telegram log cache accounting is inconsistent')
end
local prefix = string.match(KEYS[1], '^(.-):events:')
if not prefix then return redis.error_reply('Telegram log stream key is invalid') end
-- Validate every eviction before the first write: Redis Lua errors do not roll back.
local candidates = {}
local reclaimed = 0
local needed = size + string.len(ARGV[1]) + string.len(KEYS[1]) + 128 - tonumber(ARGV[2])
while reclaimed < needed do
  if #candidates >= 1000 then return redis.error_reply('Telegram log cache accounting is inconsistent') end
  local old = redis.call('LINDEX', KEYS[2], #candidates)
  if not old then return redis.error_reply('Telegram log cache accounting is incomplete') end
  local ok, item = pcall(cjson.decode, old)
  if not ok or type(item) ~= 'table' or type(item[1]) ~= 'string' or type(item[2]) ~= 'string' or type(item[3]) ~= 'number' or item[3] <= 0 or string.sub(item[1], 1, string.len(prefix) + 8) ~= prefix .. ':events:' or not string.match(item[2], '^%d+%-%d+$') then
    return redis.error_reply('Telegram log cache ledger is invalid')
  end
  local oldType = redis.call('TYPE', item[1]).ok
  if oldType ~= 'none' and oldType ~= 'stream' then return redis.error_reply('Telegram log cache has an invalid key type') end
  table.insert(candidates, item)
  reclaimed = reclaimed + item[3]
end
local id = redis.call('XADD', KEYS[1], '*', 'text', ARGV[1])
local bytes = string.len(ARGV[1]) + string.len(KEYS[1]) + string.len(id) + 64
redis.call('RPUSH', KEYS[2], cjson.encode({KEYS[1], id, bytes}))
size = size + bytes
local index = 1
while size > tonumber(ARGV[2]) do
  local item = candidates[index]
  redis.call('LPOP', KEYS[2])
  redis.call('XDEL', item[1], item[2])
  size = size - item[3]
  index = index + 1
end
redis.call('SET', KEYS[3], size)
redis.call('EXPIRE', KEYS[1], 2592000)
return id
`;
export const TELEGRAM_RENEW_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
export const TELEGRAM_RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function assertTaskId(id: string) {
  if (!TASK_ID.test(id)) throw new Error("任务编号格式不正确");
}
function validateTask(task: TelegramTask) {
  if (!task || typeof task !== "object" || !statuses.includes(task.status) || !Array.isArray(task.pending) || task.pending.some(message => typeof message !== "string") || typeof task.prompt !== "string" || !["chat", "issue"].includes(task.kind) || typeof task.createdAt !== "string" || typeof task.updatedAt !== "string") throw new Error("Telegram 任务信息不正确，原文件已保留");
  if (task.repositoryPath !== undefined && (typeof task.repositoryPath !== "string" || !path.isAbsolute(task.repositoryPath))) throw new Error("任务的仓库目录不正确，原文件已保留");
  assertTaskId(task.id); scope(task.userId, task.chatId, task.workspace);
  if (task.runner && (!Number.isSafeInteger(task.runner.pid) || task.runner.pid <= 0 || typeof task.runner.host !== "string" || typeof task.runner.startedAt !== "string")) throw new Error("Telegram 运行器信息不正确，原文件已保留");
}
function scope(userId: string, chatId: string, workspace: string) {
  if (!/^\d+$/.test(userId) || !/^-?\d+$/.test(chatId) || !path.isAbsolute(workspace)) throw new Error("Telegram 会话信息不正确");
  return hash(JSON.stringify([userId, chatId, workspace]));
}

/** Files are the durable source of task/session metadata; Redis holds replayable logs/leases. */
export class TelegramTaskStore {
  readonly botId: string;
  private root: string;
  private prefix: string;
  private secrets: readonly string[];
  constructor(private credentials: RedisCredentials, secrets: readonly string[] = []) {
    const numericId = credentials.botToken.split(":", 1)[0];
    if (!/^\d+$/.test(numericId)) throw new Error("Telegram Bot Token 格式不正确");
    this.botId = numericId;
    this.root = path.join(dataDirectory(), "telegram", this.botId);
    this.prefix = `prbot:telegram:{${this.botId}}`;
    this.secrets = [credentials.botToken, credentials.token, ...secrets];
  }
  addSecrets(secrets: readonly string[]) { this.secrets = [...new Set([...this.secrets, ...secrets])]; }
  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.credentials.url, { method: "POST", headers: { Authorization: `Bearer ${this.credentials.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Upstash 请求失败");
    const data = await response.json() as { result?: unknown; error?: string };
    if (data.error || !("result" in data)) throw new Error("Upstash 命令失败");
    return data.result;
  }
  private clean<T>(value: T, field = ""): T {
    if (typeof value === "string") return (identityFields.has(field) ? value : redactTelegram(value, this.secrets)) as T;
    if (Array.isArray(value)) return value.map(item => this.clean(item, field)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.clean(item, key)])) as T;
    return value;
  }
  private async write(name: string, value: unknown) {
    await mkdir(path.dirname(path.join(this.root, name)), { recursive: true, mode: 0o700 });
    const target = path.join(this.root, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.clean(value)) + "\n", { mode: 0o600 });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async read<T>(name: string): Promise<T | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.root, name), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid metadata");
      return value as T;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Telegram 任务文件无法读取或格式不正确，原文件已保留");
    }
  }
  async loadSession(userId: string, chatId: string, workspace: string): Promise<TelegramSession> {
    const key = scope(userId, chatId, workspace);
    const value = await this.read<TelegramSession>(`sessions/${key}.json`);
    if (value && (value.userId !== userId || value.chatId !== chatId || value.workspace !== workspace)) throw new Error("Telegram 会话信息不正确，原文件已保留");
    return value || { userId, chatId, workspace, updatedAt: new Date().toISOString() };
  }
  private async cache(name: string, value: unknown) {
    // Redis is a cache here; an outage must not undo a successfully persisted local checkpoint.
    await this.command(["SET", `${this.prefix}:${name}`, JSON.stringify(this.clean(value)), "EX", 30 * 24 * 60 * 60]).catch(() => {});
  }
  async saveSession(session: TelegramSession) {
    const key = scope(session.userId, session.chatId, session.workspace);
    session.updatedAt = new Date().toISOString();
    await this.write(`sessions/${key}.json`, session);
    await this.cache(`session:${key}`, session);
  }
  async loadTask(id: string): Promise<TelegramTask | undefined> {
    assertTaskId(id);
    const task = await this.read<TelegramTask>(`tasks/${id}.json`);
    if (task) {
      validateTask(task);
      if (task.id !== id) throw new Error("Telegram 任务编号不正确，原文件已保留");
    }
    return task;
  }
  async saveTask(task: TelegramTask) {
    validateTask(task);
    task.updatedAt = new Date().toISOString();
    await this.write(`tasks/${task.id}.json`, task);
    await this.cache(`task:${task.id}`, task);
  }
  async listTasks(userId?: string, chatId?: string, workspace?: string): Promise<TelegramTask[]> {
    let names: string[];
    try { names = await readdir(path.join(this.root, "tasks")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const tasks: TelegramTask[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !TASK_ID.test(name.slice(0, -5))) continue;
      const task = await this.loadTask(name.slice(0, -5));
      if (task && (!userId || task.userId === userId) && (!chatId || task.chatId === chatId) && (!workspace || task.workspace === workspace)) tasks.push(task);
    }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async claimUpdate(updateId: number) {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Telegram 更新编号不正确");
    const directory = path.join(this.root, "updates");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${updateId}.json`);
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(target, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { await handle.writeFile(String(Date.now())); }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try { return await this.command(["SET", `${this.prefix}:update:${updateId}`, "1", "NX", "EX", 30 * 24 * 60 * 60]) === "OK"; }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
  }
  async appendEvent(taskId: string, text: string) {
    assertTaskId(taskId);
    const value = Array.from(redactTelegram(text, this.secrets)).slice(0, EVENT_LIMIT).join("");
    const result = await this.command(["EVAL", TELEGRAM_APPEND_EVENT, 3, `${this.prefix}:events:${taskId}`, `${this.prefix}:event-index`, `${this.prefix}:event-bytes`, value, LOG_LIMIT]);
    if (typeof result !== "string" || !CURSOR.test(result)) throw new Error("Upstash 日志游标格式不正确");
    return result;
  }
  async events(taskId: string, cursor = "0-0", count = 10): Promise<{ events: TelegramEvent[]; nextCursor: string }> {
    assertTaskId(taskId);
    if (!CURSOR.test(cursor) || !Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error("日志分页参数不正确");
    const result = await this.command(["XRANGE", `${this.prefix}:events:${taskId}`, `(${cursor}`, "+", "COUNT", count]);
    if (!Array.isArray(result)) throw new Error("Upstash 日志格式不正确");
    const events = result.map(entry => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !CURSOR.test(entry[0]) || !Array.isArray(entry[1])) throw new Error("Upstash 日志格式不正确");
      const index = entry[1].indexOf("text");
      if (index < 0 || typeof entry[1][index + 1] !== "string") throw new Error("Upstash 日志格式不正确");
      return { id: entry[0], text: redactTelegram(entry[1][index + 1], this.secrets) };
    });
    return { events, nextCursor: events.at(-1)?.id || cursor };
  }
  private leaseKey(workspace: string) {
    if (!path.isAbsolute(workspace)) throw new Error("工作空间必须是绝对路径");
    // This key is deliberately shared across bots using the same Redis database.
    return `prbot:telegram:workspace:${hash(workspace)}`;
  }
  async acquireWorkspace(workspace: string, owner: string, ttlMs = 60_000) {
    if (!owner || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("工作空间锁参数不正确");
    return await this.command(["SET", this.leaseKey(workspace), owner, "NX", "PX", ttlMs]) === "OK";
  }
  async renewWorkspace(workspace: string, owner: string, ttlMs = 60_000) {
    if (!owner || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("工作空间锁参数不正确");
    return await this.command(["EVAL", TELEGRAM_RENEW_LEASE, 1, this.leaseKey(workspace), owner, ttlMs]) === 1;
  }
  async releaseWorkspace(workspace: string, owner: string) {
    return await this.command(["EVAL", TELEGRAM_RELEASE_LEASE, 1, this.leaseKey(workspace), owner]) === 1;
  }
}
