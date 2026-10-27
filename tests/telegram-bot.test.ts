import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  settings: { projectId: "p", clientId: "c", clientSecret: "s", environment: "prod", allowedUsers: "123", enabled: true },
  records: [] as Array<Record<string, unknown>>,
  openThread: vi.fn(),
}));
vi.mock("../src/lib/telegram-settings", () => ({ readTelegramSettings: async () => mocks.settings }));
vi.mock("../src/lib/config", () => ({ runtimeConfig: async () => ({ workspace: "/project" }) }));
vi.mock("../src/lib/runner", () => ({ reserve: () => ({ controller: new AbortController(), release: () => {} }) }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.openThread }));
vi.mock("../src/lib/telegram-storage", () => ({ TelegramStorage: class {
  async seen(id: number) { return mocks.records.some(record => record.updateId === id); }
  async latest() { return [...mocks.records].reverse().find(record => record.threadId || (record.role === "system" && record.text === "新对话")); }
  async append(record: Record<string, unknown>) { mocks.records.push(record); }
} }));
import { handleTelegramUpdate } from "../src/lib/telegram-bot";
const credentials = { botToken: "123:token", url: "https://example.upstash.io", token: "secret" };
const update = (id: number, user: number, text: string, type = "private") => ({ update_id: id, message: { text, chat: { id: user, type }, from: { id: user, username: "person" } } });
afterEach(() => { mocks.records.length = 0; mocks.openThread.mockReset(); vi.unstubAllGlobals(); });
describe("Telegram bridge", () => {
  it("ignores unauthorised users and group messages", async () => {
    await handleTelegramUpdate(update(1, 999, "test"), credentials, JSON.stringify(mocks.settings), ["123"]);
    await handleTelegramUpdate(update(2, 123, "test", "group"), credentials, JSON.stringify(mocks.settings), ["123"]);
    expect(mocks.records).toHaveLength(0); expect(mocks.openThread).not.toHaveBeenCalled();
  });
  it("stores the update before execution, resumes the thread and sends the answer once", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: {} })); vi.stubGlobal("fetch", fetcher);
    mocks.records.push({ role: "assistant", threadId: "old-thread" });
    mocks.openThread.mockImplementation(async (id: string) => {
      expect(id).toBe("old-thread"); expect(mocks.records.some(record => record.updateId === 3)).toBe(true);
      return { runStreamed: async () => ({ events: (async function* () { yield { type: "thread.started", thread_id: "old-thread" }; yield { type: "item.completed", item: { type: "agent_message", id: "m", text: "answer" } }; yield { type: "turn.completed" }; })() }) };
    });
    await handleTelegramUpdate(update(3, 123, "hello"), credentials, JSON.stringify(mocks.settings), ["123"]);
    await handleTelegramUpdate(update(3, 123, "hello"), credentials, JSON.stringify(mocks.settings), ["123"]);
    expect(mocks.openThread).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.records.at(-1)).toMatchObject({ role: "assistant", threadId: "old-thread", text: "answer" });
  });
});
