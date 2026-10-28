import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({
  settings: { projectId: "project", clientId: "client", clientSecret: "long-infisical-secret", environment: "prod", allowedUsers: "123,456", enabled: true },
  run: vi.fn(), open: vi.fn(), send: vi.fn(async () => {}), prepare: vi.fn(), inspect: vi.fn(), publish: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("../src/lib/telegram-settings", () => ({ readTelegramSettings: async () => mocks.settings }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.open, activity: () => undefined }));
vi.mock("../src/lib/telegram-api", () => ({ telegramSend: mocks.send }));
vi.mock("../src/lib/telegram-github", () => ({ parseIssueLink: (url: string) => ({ owner: "owner", repo: "repo", number: 14, url }), inspectIssue: mocks.inspect, prepareIssue: mocks.prepare, reviewSnapshot: mocks.snapshot, publishIssue: mocks.publish }));
import { dispatchTelegram, recoverTelegramTasks } from "../src/lib/telegram-worker";
import { TelegramTaskStore, type TelegramTask } from "../src/lib/telegram-task-store";
import { reserve, clearWorkspaceQuarantine } from "../src/lib/runner";
let directory: string;
const credentials = { botToken: "12345:worker-token", token: "upstash-worker-secret", url: "https://example.upstash.io" };
const settingsKey = () => JSON.stringify(mocks.settings);
let store: TelegramTaskStore;
function dispatch(text: string, action: "message" | "confirm" | "continue" | "cancel" | "new" | "finishissue" = "message", questionId?: string) {
  return dispatchTelegram({ text, action, questionId, userId: "123", chatId: "123", workspace: directory, credentials, settingsKey: settingsKey() });
}
async function current() { const session = await store.loadSession("123", "123", directory); return session.taskId ? store.loadTask(session.taskId) : undefined; }
async function wait(status: TelegramTask["status"]) { await vi.waitFor(async () => expect((await current())?.status).toBe(status), { timeout: 5000 }); return (await current())!; }
async function confirm() { const task = (await current())!; await dispatch(task.question!.id, "confirm", task.question!.id); }
const result = (status = "completed", question: object | null = null) => JSON.stringify({ status, summary: "已处理", question });
function fixture(text: string) {
  mocks.run.mockImplementation(async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "stable-thread" };
    yield { type: "item.completed", item: { type: "agent_message", id: "answer", text } };
    yield { type: "turn.completed" };
  })() }));
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "prbot-worker-"));
  vi.stubEnv("PRBOT_DATA_DIR", path.join(directory, "data")); vi.stubEnv("CODEX_WORKSPACE", directory);
  vi.stubEnv("PRBOT_SETTINGS_FILE", path.join(directory, "settings.json"));
  vi.stubEnv("CODEX_PATH_OVERRIDE", ""); vi.stubEnv("CODEX_HOME", "");
  mocks.run.mockReset(); mocks.open.mockReset(); mocks.send.mockClear(); mocks.inspect.mockReset(); mocks.prepare.mockReset(); mocks.snapshot.mockReset(); mocks.publish.mockReset();
  mocks.open.mockImplementation(async () => ({ runStreamed: mocks.run }));
  let cursor = 0; const keys = new Map<string, string>();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
    const args = JSON.parse(String(options.body)); let value: unknown = "OK";
    if (args[0] === "SET") {
      if (args.includes("NX") && keys.has(args[1])) value = null;
      else keys.set(args[1], args[2]);
    }
    if (args[0] === "EVAL") {
      if (args[2] === 3) value = `${++cursor}-0`;
      else {
        value = keys.get(args[3]) === args[4] ? 1 : 0;
        if (String(args[1]).includes("'DEL'") && value === 1) keys.delete(args[3]);
      }
    }
    return Response.json({ result: value });
  }));
  store = new TelegramTaskStore(credentials);
});
afterEach(async () => {
  clearWorkspaceQuarantine(directory);
  await vi.waitFor(() => expect((globalThis as { prbotTelegramJobs?: Map<string, unknown> }).prbotTelegramJobs?.size || 0).toBe(0));
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});
describe("durable Telegram worker", { timeout: 15_000 }, () => {
  it("requires explicit confirmation, then resumes a stable thread across questions", async () => {
    fixture(result("waiting_input", { text: "用哪个目录？", choices: ["src", "lib"], highRisk: false }));
    await dispatch("完成代码修改"); expect(mocks.open).not.toHaveBeenCalled();
    const initial = (await current())!; expect(initial.question?.highRisk).toBe(true);
    await confirm(); const question = await wait("waiting_input");
    expect(question.threadId).toBe("stable-thread"); expect(question.question?.text).toBe("用哪个目录？");
    fixture(result()); await dispatch("src"); await wait("completed");
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: directory });
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("回答问题");
    expect((await store.loadSession("123", "123", directory)).threadId).toBe("stable-thread");
  });
  it("keeps the original request when a follow-up arrives before the turn starts", async () => {
    fixture(result()); await dispatch("原始任务");
    const lock = reserve("test-other-owner", directory);
    try { await confirm(); await dispatch("补充要求"); expect((await current())?.pending).toEqual(["原始任务", "补充要求"]); }
    finally { lock.release(); }
    await wait("completed");
    expect(mocks.run.mock.calls[0][0]).toContain("原始任务\n\n补充要求");
  });
  it("feeds a model confirmation into the same thread instead of repeating the original prompt", async () => {
    fixture(result("waiting_input", { text: "确认修改迁移文件？", choices: [], highRisk: true }));
    await dispatch("修改迁移"); await confirm(); await wait("waiting_input");
    fixture(result()); await confirm(); await wait("completed");
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("用户已明确确认问题");
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: directory });
  });
  it("cancels an active turn, quarantines its workspace, and requires a fresh stop check", async () => {
    mocks.run.mockImplementation(async (_prompt: string, options: { signal: AbortSignal }) => ({ events: (async function* () {
      yield { type: "thread.started", thread_id: "stable-thread" };
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    })() }));
    await dispatch("长任务"); await confirm(); await wait("running");
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
    await dispatch("", "cancel"); const cancelled = await wait("cancelled");
    expect(cancelled.requiresStopCheck).toBe(true); expect(cancelled.threadId).toBe("stable-thread");
    expect(() => reserve("another-writer", directory)).toThrow("子进程");
    await dispatch("", "continue"); const recovery = (await current())!;
    expect(recovery.question?.text).toContain("子进程已经停止");
    fixture(result()); await confirm(); await wait("completed");
    const available = reserve("after-stop-check", directory); available.release();
  });
  it("rejects stale confirmation and keeps issue delivery waiting for review", async () => {
    mocks.inspect.mockResolvedValue({ owner: "owner", repo: "repo", number: 14, url: "https://github.com/owner/repo/issues/14", title: "Issue", baseBranch: "main" });
    mocks.prepare.mockResolvedValue({ branch: "feature/issue-14", baseBranch: "main" });
    mocks.snapshot.mockResolvedValue({ fingerprint: "reviewed", summary: "1 file changed", hasChanges: true });
    mocks.publish.mockResolvedValue("https://github.com/owner/repo/pull/15");
    fixture(result("ready_to_publish"));
    await dispatch("", "finishissue"); await dispatch("https://github.com/owner/repo/issues/14"); await wait("waiting_input");
    await dispatch("expired", "confirm", "expired"); expect(mocks.open).not.toHaveBeenCalled();
    await confirm(); const ready = await wait("waiting_input"); expect(ready.stage).toBe("confirm_publish");
    expect(mocks.publish).not.toHaveBeenCalled();
    await confirm(); const published = await wait("awaiting_review");
    expect(published.prUrl).toMatch(/pull\/15$/); expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("marks a dead runner interrupted after restart without replaying the task", async () => {
    await dispatch("restart check"); const task = (await current())!;
    task.status = "running"; task.runner = { pid: 2147483647, host: os.hostname(), startedAt: new Date().toISOString() }; await store.saveTask(task);
    await recoverTelegramTasks(credentials, settingsKey());
    expect((await current())?.status).toBe("interrupted"); expect(mocks.open).not.toHaveBeenCalled();
    expect((await current())?.requiresStopCheck).toBe(true);
  });
});
