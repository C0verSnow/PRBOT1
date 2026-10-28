import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const settings = vi.hoisted(() => ({ projectId: "ci-project", clientId: "ci-client", clientSecret: "flow-infisical-private-secret", environment: "prod", allowedUsers: "123", enabled: true }));
vi.mock("../src/lib/telegram-settings", () => ({ readTelegramSettings: async () => settings }));
import { handleTelegramUpdate, type TelegramUpdate } from "../src/lib/telegram-bot";
import { TelegramTaskStore, type TelegramTask } from "../src/lib/telegram-task-store";
import { clearWorkspaceQuarantine } from "../src/lib/runner";

// CI bridges Upstash's REST command shape to the service's real Redis instance.
// Only Telegram's network transport and local settings are fixtures; SDK execution,
// the subprocess, durable state, Redis Lua/Streams, command intake and worker are real.
const redis = (...args: (string | number)[]): unknown => JSON.parse(execFileSync("redis-cli", ["--json", ...args.map(String)], { encoding: "utf8" }).trim());
const credentials = { botToken: "99991:telegram-flow-private-token", token: "flow-redis-private-token", url: "https://flow.upstash.io" };
let directory: string;
let store: TelegramTaskStore;
let sent: Array<{ method: string; body: Record<string, unknown> }>;
const update = (id: number, text: string, user = 123): TelegramUpdate => ({ update_id: id, message: { text, chat: { id: user, type: "private" }, from: { id: user } } });
const receive = (value: TelegramUpdate) => handleTelegramUpdate(value, credentials, JSON.stringify(settings), ["123"]);
async function current() {
  const session = await store.loadSession("123", "123", directory);
  return session.taskId ? store.loadTask(session.taskId) : undefined;
}
async function waitForTask(status: TelegramTask["status"]) {
  await vi.waitFor(async () => expect((await current())?.status).toBe(status), { timeout: 10_000 });
  return (await current())!;
}
function cleanRedis() {
  const keys = redis("KEYS", "prbot:telegram:{99991}:*") as string[];
  if (directory) keys.push(`prbot:telegram:workspace:${createHash("sha256").update(directory).digest("hex")}`);
  if (keys.length) redis("DEL", ...keys);
}

// This test is intentionally run only by the existing remote CI Redis job.
describe.skipIf(process.env.PRBOT_TEST_REDIS !== "1")("Telegram → worker → SDK subprocess → disk → Telegram", () => {
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prbot-telegram-flow-")));
    sent = []; cleanRedis();
    vi.stubEnv("PRBOT_DATA_DIR", path.join(directory, "data"));
    vi.stubEnv("PRBOT_SETTINGS_FILE", path.join(directory, "settings.json"));
    vi.stubEnv("CODEX_WORKSPACE", directory); vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("CODEX_PATH_OVERRIDE", path.resolve("scripts/fake-codex.mjs"));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input); const body = JSON.parse(String(options?.body));
      if (url === credentials.url) return Response.json({ result: redis(...body as (string | number)[]) });
      if (url.startsWith(`https://api.telegram.org/bot${credentials.botToken}/`)) {
        sent.push({ method: url.slice(url.lastIndexOf("/") + 1), body });
        return Response.json({ ok: true, result: {} });
      }
      throw new Error("Unexpected external request in isolated Telegram flow fixture");
    }));
    store = new TelegramTaskStore(credentials);
  });
  afterEach(async () => {
    await vi.waitFor(() => expect((globalThis as { prbotTelegramJobs?: Map<string, unknown> }).prbotTelegramJobs?.size || 0).toBe(0), { timeout: 10_000 });
    clearWorkspaceQuarantine(directory); cleanRedis();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("authorizes and deduplicates intake, answers directly, reports logs and resumes the same thread", async () => {
    await receive(update(1, "写入测试文件", 999));
    expect(await current()).toBeUndefined(); expect(sent).toHaveLength(0);
    await receive(update(2, "/START"));
    expect(sent.some(message => String(message.body.text).includes("欢迎使用 PRBOT"))).toBe(true);

    const original = update(3, "写入测试文件");
    await receive(original);
    await receive(original); expect((await store.listTasks("123", "123", directory))).toHaveLength(1);
    const first = await waitForTask("completed");
    expect(await readFile(path.join(directory, "sdk-evidence.txt"), "utf8")).toContain("written through SDK subprocess");
    expect(first.threadId).toBeTruthy();
    const texts = sent.map(message => String(message.body.text));
    expect(texts.findIndex(text => text.includes("消息已收到"))).toBeLessThan(texts.findIndex(text => text.includes("开始执行")));
    expect(texts.join("\n")).not.toMatch(/允许 Codex|等待执行确认|已隐藏密钥.*confirm/);
    expect((await store.loadSession("123", "123", directory)).threadId).toBe(first.threadId);
    await vi.waitFor(() => expect(sent.some(message => String(message.body.text).includes("你好！我已连接"))).toBe(true));

    await receive(update(5, "/status"));
    await receive(update(6, "/logs"));
    expect(sent.some(message => String(message.body.text).includes(`任务：${first.id}`) && String(message.body.text).includes("completed"))).toBe(true);
    expect(sent.some(message => String(message.body.text).includes("sdk-evidence.txt") && String(message.body.text).includes("接着查看：/logs"))).toBe(true);
    const logs = await store.events(first.id, "0-0", 50);
    expect(logs.events.some(event => event.text.includes("pwd"))).toBe(true);
    const rest = await store.events(first.id, logs.nextCursor, 50); expect(rest.events).toHaveLength(0);

    await receive(update(7, "继续原来的任务"));
    const second = await waitForTask("completed");
    expect(second.id).not.toBe(first.id); expect(second.threadId).toBe(first.threadId);
    await vi.waitFor(() => expect(sent.some(message => String(message.body.text).includes("接着上次对话"))).toBe(true), { timeout: 10_000 });
    expect(await store.listTasks("123", "123", directory)).toHaveLength(2);
  }, 30_000);
});
