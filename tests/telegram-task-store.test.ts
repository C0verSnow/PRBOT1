import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TelegramTaskStore, TELEGRAM_APPEND_EVENT, TELEGRAM_RELEASE_LEASE, TELEGRAM_RENEW_LEASE, type TelegramTask } from "../src/lib/telegram-task-store";

let directory: string;
const credentials = { botToken: "123:telegram-private-token", token: "upstash-private-token", url: "https://example.upstash.io" };
const task = (): TelegramTask => ({ id: "task_001", kind: "chat", userId: "123", chatId: "123", workspace: "/project", status: "queued", prompt: "hello", pending: [], createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" });
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "prbot-telegram-state-"));
  vi.stubEnv("PRBOT_DATA_DIR", directory);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ result: "OK" })));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

describe("durable Telegram task checkpoints", () => {
  it("recovers state and stable thread mapping after Redis loss and token rotation", async () => {
    const store = new TelegramTaskStore(credentials);
    const session = await store.loadSession("123", "123", "/project");
    expect(session.taskId).toBeUndefined();
    session.threadId = "thread_001"; session.taskId = "task_001"; await store.saveSession(session);
    await store.saveTask({ ...task(), threadId: "thread_001", pending: ["additional requirement"], runner: { pid: 12345, host: "host", startedAt: "now" } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { throw new Error("Redis unavailable"); }));
    const restarted = new TelegramTaskStore({ ...credentials, botToken: "123:rotated-token" });
    expect(await restarted.loadSession("123", "123", "/project")).toMatchObject({ threadId: "thread_001", taskId: "task_001" });
    expect(await restarted.loadTask("task_001")).toMatchObject({ threadId: "thread_001", pending: ["additional requirement"], runner: { pid: 12345 } });
    const saved = (await restarted.loadTask("task_001"))!; saved.status = "interrupted";
    await restarted.saveTask(saved);
    expect((await restarted.loadTask("task_001"))?.status).toBe("interrupted");
    expect(await restarted.loadSession("123", "123", "/different")).not.toHaveProperty("threadId");
    expect(await restarted.listTasks("999")).toHaveLength(0);
    expect(await restarted.listTasks("123", "123", "/project")).toHaveLength(1);
  });
  it("redacts task content before local persistence and Redis caching", async () => {
    const fetcher = vi.mocked(fetch);
    const store = new TelegramTaskStore(credentials, ["codex-private-key"]);
    await store.saveTask({ ...task(), prompt: `${credentials.botToken} codex-private-key`, pending: [credentials.token], question: { id: "q1", text: "GITHUB_TOKEN=private-reply" } });
    const disk = await readFile(path.join(directory, "telegram", "123", "tasks", "task_001.json"), "utf8");
    const cached = String(JSON.parse(String(fetcher.mock.calls[0][1]?.body))[2]);
    for (const data of [disk, cached]) {
      for (const secret of [credentials.botToken, credentials.token, "codex-private-key", "private-reply"]) expect(data).not.toContain(secret);
      expect(data).toContain("已隐藏密钥");
    }
  });
  it("keeps machine identities usable when a configured secret has a short value", async () => {
    const store = new TelegramTaskStore(credentials, ["s"]);
    await store.saveTask({ ...task(), prompt: "s", status: "running", threadId: "thread-s" });
    expect(await store.loadTask("task_001")).toMatchObject({ status: "running", threadId: "thread-s", prompt: "[已隐藏密钥]" });
  });
  it("rejects invalid metadata and task traversal without touching files", async () => {
    const store = new TelegramTaskStore(credentials);
    await expect(store.loadTask("../settings")).rejects.toThrow("任务编号");
    await expect(store.saveSession({ userId: "123", chatId: "123", workspace: "relative", updatedAt: "now" })).rejects.toThrow("会话信息");
    await expect(store.saveTask({ ...task(), pending: [123] as unknown as string[] })).rejects.toThrow("任务信息");
  });
  it("atomically remembers updates locally as well as in Redis", async () => {
    const store = new TelegramTaskStore(credentials);
    expect(await store.claimUpdate(123)).toBe(true);
    expect(await store.claimUpdate(123)).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const restarted = new TelegramTaskStore({ ...credentials, botToken: "123:new-token" });
    expect(await restarted.claimUpdate(123)).toBe(false);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { throw new Error("Redis unavailable"); }));
    await expect(store.claimUpdate(124)).rejects.toThrow("Redis unavailable");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ result: "OK" })));
    expect(await store.claimUpdate(124)).toBe(true);
  });
  it("claims a duplicate Redis update without executing it again after local state replacement", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ result: null })));
    const store = new TelegramTaskStore(credentials);
    expect(await store.claimUpdate(123)).toBe(false);
    expect(await store.claimUpdate(123)).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("Redis event cursors and workspace leases", () => {
  it("uses exclusive cursors, redacts on replay and limits pagination", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: [["100-1", ["text", "command CODEX_API_KEY=unsafe"]], ["101-0", ["text", "done"]]] }));
    vi.stubGlobal("fetch", fetcher);
    const store = new TelegramTaskStore(credentials);
    const page = await store.events("task_001", "100-0", 2);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(["XRANGE", "prbot:telegram:{123}:events:task_001", "(100-0", "+", "COUNT", 2]);
    expect(page).toEqual({ events: [{ id: "100-1", text: "command CODEX_API_KEY=[已隐藏密钥]" }, { id: "101-0", text: "done" }], nextCursor: "101-0" });
    await expect(store.events("task_001", "invalid")).rejects.toThrow("分页参数");
    await expect(store.events("task_001", "0-0", 51)).rejects.toThrow("分页参数");
  });
  it("redacts before XADD and keeps Unicode characters intact while bounding one event", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: "100-0" })); vi.stubGlobal("fetch", fetcher);
    const store = new TelegramTaskStore(credentials);
    expect(await store.appendEvent("task_001", `${credentials.token} ${"😀".repeat(20_000)}`)).toBe("100-0");
    const args = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as (string | number)[];
    expect(String(args[6])).not.toContain(credentials.token);
    expect(Array.from(String(args[6]))).toHaveLength(16_000);
    expect(String(args[6]).endsWith("😀")).toBe(true);
  });
  it("shares workspace locks across bots and only renews/releases the owning token", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json({ result: JSON.parse(String(init?.body))[0] === "SET" ? "OK" : 1 }));
    vi.stubGlobal("fetch", fetcher);
    const first = new TelegramTaskStore(credentials); const other = new TelegramTaskStore({ ...credentials, botToken: "456:other-token" });
    expect(await first.acquireWorkspace("/project", "owner-a")).toBe(true);
    expect(await other.renewWorkspace("/project", "owner-a")).toBe(true);
    expect(await first.releaseWorkspace("/project", "owner-a")).toBe(true);
    const commands = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)) as (string | number)[]);
    expect(commands[0][1]).toBe(commands[1][3]); expect(commands[0][1]).toBe(commands[2][3]);
    expect(commands[1][1]).toBe(TELEGRAM_RENEW_LEASE); expect(commands[2][1]).toBe(TELEGRAM_RELEASE_LEASE);
    expect(commands[1][4]).toBe("owner-a");
  });
});

const redis = (...args: string[]) => execFileSync("redis-cli", ["--raw", ...args], { encoding: "utf8" }).trim();
describe.skipIf(process.env.PRBOT_TEST_REDIS !== "1")("real Redis Telegram scripts (CI only)", () => {
  it("evicts stream events atomically within the rolling byte budget", () => {
    const base = `prbot:test:telegram:${process.pid}`;
    const keys = [`${base}:events:stream`, `${base}:index`, `${base}:bytes`];
    try {
      redis("DEL", ...keys);
      const first = redis("EVAL", TELEGRAM_APPEND_EVENT, "3", ...keys, "a".repeat(100), "500");
      const second = redis("EVAL", TELEGRAM_APPEND_EVENT, "3", ...keys, "b".repeat(300), "500");
      expect(redis("XRANGE", keys[0], first, first)).toBe("");
      expect(redis("XRANGE", keys[0], second, second)).toContain("b".repeat(300));
      expect(Number(redis("GET", keys[2]))).toBeLessThanOrEqual(500);
    } finally { redis("DEL", ...keys); }
  });
  it("rejects a corrupt eviction ledger before adding an unaccounted event", () => {
    const base = `prbot:test:corrupt:${process.pid}`;
    const keys = [`${base}:events:stream`, `${base}:index`, `${base}:bytes`];
    try {
      redis("DEL", ...keys);
      redis("RPUSH", keys[1], "not-json"); redis("SET", keys[2], "499");
      expect(redis("EVAL", TELEGRAM_APPEND_EVENT, "3", ...keys, "new", "500")).toContain("ledger is invalid");
      expect(redis("XLEN", keys[0])).toBe("0");
      expect(redis("GET", keys[2])).toBe("499");
    } finally { redis("DEL", ...keys); }
  });
  it("does not renew or delete a lock owned by a different runner", () => {
    const key = `prbot:test:lease:${process.pid}`;
    try {
      redis("SET", key, "first", "PX", "60000");
      expect(redis("EVAL", TELEGRAM_RENEW_LEASE, "1", key, "second", "60000")).toBe("0");
      expect(redis("EVAL", TELEGRAM_RELEASE_LEASE, "1", key, "second")).toBe("0");
      expect(redis("GET", key)).toBe("first");
      expect(redis("EVAL", TELEGRAM_RELEASE_LEASE, "1", key, "first")).toBe("1");
    } finally { redis("DEL", key); }
  });
});
