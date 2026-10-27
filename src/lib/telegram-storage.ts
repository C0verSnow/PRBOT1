import { createHash } from "node:crypto";

export type TelegramRecord = { userId: string; username?: string; chatId: string; workspace: string; threadId?: string; updateId?: number; role: "user" | "assistant" | "system"; text: string; time: string };
export type RedisCredentials = { url: string; token: string; botToken: string };
const LIMIT = 50 * 1024 * 1024;
// The list is ordered newest first. Lua makes accounting and eviction one atomic operation.
export const APPEND = `
local size = tonumber(redis.call('GET', KEYS[2]) or '0')
local item = ARGV[1]
local limit = tonumber(ARGV[2])
if string.len(item) > limit then return -1 end
redis.call('LPUSH', KEYS[1], item)
size = size + string.len(item)
while size > limit do
  local old = redis.call('RPOP', KEYS[1])
  if not old then break end
  size = size - string.len(old)
end
redis.call('SET', KEYS[2], size)
return size
`;
export class TelegramStorage {
  private list: string;
  private size: string;
  private botId: string;
  constructor(private credentials: RedisCredentials) {
    this.botId = createHash("sha256").update(credentials.botToken).digest("hex").slice(0, 24);
    this.list = "prbot:telegram:records";
    this.size = "prbot:telegram:bytes";
  }
  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.credentials.url, { method: "POST", headers: { Authorization: `Bearer ${this.credentials.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Upstash 请求失败");
    const data = await response.json() as { result?: unknown; error?: string };
    if (data.error) throw new Error("Upstash 命令失败");
    return data.result;
  }
  async append(record: TelegramRecord) {
    const value = JSON.stringify({ ...record, botId: this.botId });
    if (Buffer.byteLength(value) > LIMIT) throw new Error("Telegram 消息超过存储上限");
    if (await this.command(["EVAL", APPEND, 2, this.list, this.size, value, LIMIT]) === -1) throw new Error("Telegram 消息超过存储上限");
  }
  async seen(updateId: number) {
    for (let offset = 0; ; offset += 100) {
      const records = await this.command(["LRANGE", this.list, offset, offset + 99]);
      if (!Array.isArray(records)) throw new Error("Upstash 记录格式不正确");
      for (const item of records) if (typeof item === "string" && (JSON.parse(item) as TelegramRecord & { botId?: string }).botId === this.botId && (JSON.parse(item) as TelegramRecord).updateId === updateId) return true;
      if (records.length < 100) return false;
    }
  }
  async latest(userId: string, chatId: string, workspace: string) {
    for (let offset = 0; ; offset += 100) {
      const records = await this.command(["LRANGE", this.list, offset, offset + 99]);
      if (!Array.isArray(records)) throw new Error("Upstash 记录格式不正确");
      for (const item of records) {
        if (typeof item !== "string") throw new Error("Upstash 记录格式不正确");
        const value = JSON.parse(item) as TelegramRecord & { botId?: string };
        if (value.botId === this.botId && value.userId === userId && value.chatId === chatId && value.workspace === workspace && (value.threadId || (value.role === "system" && value.text === "新对话"))) return value;
      }
      if (records.length < 100) return undefined;
    }
  }
}
