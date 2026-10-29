import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { projectId: "p", clientId: "c", clientSecret: "settings-secret-abcdefghijkl", environment: "prod", allowedUsers: "123", enabled: true },
  claimed: new Set<number>(),
  dispatch: vi.fn(),
  events: vi.fn(),
  tasks: [] as Array<Record<string, unknown>>,
  session: { userId: "123", chatId: "123", workspace: "/project", updatedAt: "2026-10-28" } as Record<string, unknown>,
}));
vi.mock("../src/lib/telegram-settings", () => ({ readTelegramSettings: async () => mocks.settings }));
vi.mock("../src/lib/config", () => ({ runtimeConfig: async () => ({ workspace: "/project", env: { CODEX_API_KEY: "codex-private-key-abcdefghijkl" } }) }));
vi.mock("../src/lib/telegram-worker", () => ({ dispatchTelegram: mocks.dispatch, recoverTelegramTasks: vi.fn() }));
vi.mock("../src/lib/telegram-task-store", () => ({ TelegramTaskStore: class {
  async claimUpdate(id: number) { if (mocks.claimed.has(id)) return false; mocks.claimed.add(id); return true; }
  async loadSession() { return mocks.session; }
  async loadTask(id: string) { return mocks.tasks.find(task => task.id === id); }
  async listTasks(userId: string, chatId: string, workspace: string) { return mocks.tasks.filter(task => task.userId === userId && task.chatId === chatId && task.workspace === workspace); }
  events = mocks.events;
} }));
import { handleTelegramUpdate, isTelegramUpdate, parseTelegramCommand } from "../src/lib/telegram-bot";
import { telegramChunks, telegramSend } from "../src/lib/telegram-api";
const credentials = { botToken: "123:token", url: "https://example.upstash.io", token: "redis-private-token-abcdefghijkl" };
const update = (id: number, user: number, text: string, type = "private") => ({ update_id: id, message: { text, chat: { id: user, type }, from: { id: user, username: "person" } } });
const receive = (value: Parameters<typeof handleTelegramUpdate>[0], options?: Parameters<typeof handleTelegramUpdate>[4]) => handleTelegramUpdate(value, credentials, JSON.stringify(mocks.settings), ["123"], options);
let requests: Array<{ url: string; body: Record<string, unknown> }>;
beforeEach(() => {
  requests = []; mocks.claimed.clear(); mocks.tasks.length = 0;
  mocks.session = { userId: "123", chatId: "123", workspace: "/project", updatedAt: "2026-10-28" };
  mocks.settings.enabled = true; mocks.settings.allowedUsers = "123";
  mocks.dispatch.mockReset().mockResolvedValue("已收到，任务已排队。"); mocks.events.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(options.body)) });
    return Response.json({ ok: true, result: {} });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Telegram command intake", () => {
  it("rejects malformed nested webhook fields before accessing them", () => {
    expect(isTelegramUpdate({ update_id: 1, message: { chat: null } })).toBe(false);
    expect(isTelegramUpdate({ update_id: 1, callback_query: { id: "q", from: null } })).toBe(false);
    expect(isTelegramUpdate({ update_id: 1, callback_query: { id: "q", from: { id: 123 }, message: { chat: "bad" } } })).toBe(false);
    expect(isTelegramUpdate({ update_id: 1 })).toBe(true);
  });
  it("recognizes case-insensitive slash commands, bot mentions and text aliases", () => {
    expect(parseTelegramCommand(" /FinishIssue@my_bot https://github.com/a/b/issues/1 ")).toEqual({ name: "finishissue", argument: "https://github.com/a/b/issues/1" });
    expect(parseTelegramCommand("finish issue")).toEqual({ name: "finishissue", argument: "" });
    expect(parseTelegramCommand("HELP")).toEqual({ name: "help", argument: "" });
    expect(parseTelegramCommand("请继续修改帮助文档")).toBeUndefined();
    expect(parseTelegramCommand("help me debug this issue")).toBeUndefined();
    expect(parseTelegramCommand("cancel the subscription UI change")).toBeUndefined();
  });
  it("ignores unauthorized, group, bot and disabled-setting messages before dedupe", async () => {
    await receive(update(1, 999, "hello"));
    await receive(update(2, 123, "hello", "group"));
    const bot = update(3, 123, "hello"); Object.assign(bot.message.from, { is_bot: true }); await receive(bot);
    mocks.settings.enabled = false; await receive(update(4, 123, "hello"));
    expect(mocks.claimed.size).toBe(0); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  });
  it("answers start/help/id locally without launching a Codex task", async () => {
    await receive(update(1, 123, "/START@my_bot")); await receive(update(2, 123, "help")); await receive(update(3, 123, "/ID"));
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(requests[0].body.text).toContain("工作空间：/project");
    expect(requests[1].body.text).toContain("/FinishIssue"); expect(requests[2].body.text).toContain("123");
  });
  it("durably claims each update once and forwards follow-up messages to the worker", async () => {
    const message = update(10, 123, "继续上次任务");
    await receive(message); await receive(message); await receive(update(11, 123, "还要更新文档"));
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls[0][0]).toMatchObject({ action: "message", text: "继续上次任务", workspace: "/project", userId: "123", chatId: "123" });
    expect(mocks.claimed).toEqual(new Set([10, 11]));
  });
  it("routes issue, continue, new and cancel commands without treating them as prompts", async () => {
    for (const [index, command] of ["/FinishIssue", "/CONTINUE", "/new", "/cancel"].entries()) await receive(update(index, 123, command));
    expect(mocks.dispatch.mock.calls.map(call => call[0].action)).toEqual(["finishissue", "continue", "new", "cancel"]);
  });
  it("passes callback identity and the exact question id to worker ownership checks", async () => {
    await receive({ update_id: 4, callback_query: { id: "callback", data: "confirm:question-1", from: { id: 123 }, message: { chat: { id: 123, type: "private" }, from: { id: 555, is_bot: true } } } });
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "confirm", questionId: "question-1", userId: "123", chatId: "123" }));
    expect(requests[0].url).toContain("answerCallbackQuery");
    await receive(update(5, 123, "/confirm question-2"));
    expect(mocks.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ action: "confirm", questionId: "question-2" }));
  });
  it("never launches a task for unknown commands or invalid log cursors", async () => {
    mocks.session.taskId = "task-1"; mocks.tasks.push({ id: "task-1", userId: "123", chatId: "123", workspace: "/project", status: "running" });
    await receive(update(1, 123, "/unsupported")); await receive(update(2, 123, "/logs ../../file"));
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.events).not.toHaveBeenCalled();
  });
  it("returns current status and logs with a continuation cursor while the task runs", async () => {
    mocks.session.taskId = "task-1"; mocks.tasks.push({ id: "task-1", userId: "123", chatId: "123", workspace: "/project", status: "running", stage: "正在修改代码" });
    mocks.events.mockResolvedValue({ events: [{ id: "12-1", text: "执行命令：pwd" }], nextCursor: "12-1" });
    await receive(update(1, 123, "/status")); await receive(update(2, 123, "/logs 10-0"));
    expect(requests[0].body.text).toContain("running"); expect(requests[1].body.text).toContain("/logs 12-1");
    expect(mocks.events).toHaveBeenCalledWith("task-1", "10-0", 5); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("does not reveal another user's task when a session mapping is stale", async () => {
    mocks.session.taskId = "other"; mocks.tasks.push({ id: "other", userId: "999", chatId: "999", workspace: "/project", status: "running", error: "private detail" });
    await receive(update(1, 123, "/status"));
    expect(requests[0].body.text).not.toContain("private detail"); expect(requests[0].body.text).toContain("当前没有任务");
  });
  it("acknowledges webhook intake while retaining ordered Telegram sends", async () => {
    let finish: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ ok: true, result: {} })); })));
    await receive(update(1, 123, "task"), { waitForReply: false });
    await vi.waitFor(() => expect(finish).toBeDefined()); expect(mocks.dispatch).toHaveBeenCalledOnce(); finish!();
  });
  it("explains rejected Issue input and redacts exception messages", async () => {
    mocks.dispatch.mockRejectedValue(new Error("Issue 链接无效 codex-private-key-abcdefghijkl"));
    await receive(update(1, 123, "bad issue"));
    expect(requests[0].body.text).toContain("Issue 链接无效"); expect(requests[0].body.text).not.toContain("codex-private-key");
  });
  it("propagates intake failures so webhook transport can request a retry", async () => {
    mocks.dispatch.mockRejectedValue(new Error("Upstash unavailable"));
    await expect(receive(update(1, 123, "task"), { waitForReply: false })).rejects.toThrow("Upstash unavailable");
  });
  it("redacts runtime and settings secrets before sending worker replies", async () => {
    mocks.dispatch.mockResolvedValue("codex-private-key-abcdefghijkl settings-secret-abcdefghijkl redis-private-token-abcdefghijkl 123:token");
    await receive(update(1, 123, "hello"));
    expect(requests[0].body.text).not.toMatch(/codex-private|settings-secret|redis-private|123:token/);
  });
});

describe("Telegram output bounds", () => {
  it("keeps chunks and multiple producers in FIFO order while another chat can send", async () => {
    let finishFirst: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)); requests.push({ url, body });
      if (body.text === "A".repeat(4000)) await new Promise<void>(resolve => { finishFirst = resolve; });
      return Response.json({ ok: true, result: {} });
    }));
    const first = telegramSend(credentials, "fifo", "A".repeat(4001));
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    const next = telegramSend(credentials, "fifo", "worker progress");
    await telegramSend(credentials, "other-chat", "independent");
    expect(requests.map(request => request.body.text)).toEqual(["A".repeat(4000), "independent"]);
    finishFirst!(); await Promise.all([first, next]);
    expect(requests.filter(request => request.body.chat_id === "fifo").map(request => request.body.text)).toEqual(["A".repeat(4000), "A", "worker progress"]);
  });
  it("keeps emoji messages within Telegram's UTF-16 limit without broken pairs", async () => {
    const text = "😀".repeat(5000); const chunks = telegramChunks(text);
    expect(chunks.every(chunk => chunk.length <= 4000)).toBe(true); expect(chunks.join("")).toBe(text);
    await telegramSend(credentials, "123", text, [{ text: "确认", data: "confirm:q1" }]);
    expect(requests).toHaveLength(3); expect(requests[0].body.reply_markup).toBeUndefined();
    expect(requests[2].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "确认", callback_data: "confirm:q1" }]] });
  });
});
