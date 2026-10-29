import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({
  settings: { projectId: "project", clientId: "client", clientSecret: "long-infisical-secret", environment: "prod", allowedUsers: "123,456", enabled: true },
  run: vi.fn(), open: vi.fn(), send: vi.fn(async () => {}), ensure: vi.fn(), prepare: vi.fn(), inspect: vi.fn(), publish: vi.fn(), snapshot: vi.fn(), git: vi.fn(),
}));
vi.mock("../src/lib/telegram-settings", () => ({ readTelegramSettings: async () => mocks.settings }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.open, activity: () => undefined }));
vi.mock("../src/lib/telegram-api", () => ({ telegramSend: mocks.send }));
vi.mock("../src/lib/telegram-github", () => ({ ensureIssueRepository: mocks.ensure, git: mocks.git, parseIssueLink: (url: string) => ({ owner: "owner", repo: "repo", number: 14, url }), inspectIssue: mocks.inspect, prepareIssue: mocks.prepare, reviewSnapshot: mocks.snapshot, publishIssue: mocks.publish }));
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
  mocks.ensure.mockReset().mockImplementation(async (workspace, _issue, _signal, options) => {
    await options.beforePrepare?.(workspace);
    return workspace;
  });
  mocks.git.mockReset().mockResolvedValue("feature/issue-14");
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
async function seed(fields: Partial<TelegramTask> = {}) {
  const stamp = new Date().toISOString();
  const task: TelegramTask = { id: "seed-task", userId: "123", chatId: "123", workspace: directory, kind: "chat", status: "failed", stage: "failed", prompt: "原任务", pending: [], createdAt: stamp, updatedAt: stamp, ...fields };
  await store.saveTask(task);
  await store.saveSession({ userId: "123", chatId: "123", workspace: directory, taskId: task.id, threadId: task.threadId, updatedAt: stamp });
  return task;
}
function issueFixture() {
  mocks.inspect.mockResolvedValue({ owner: "owner", repo: "repo", number: 14, url: "https://github.com/owner/repo/issues/14", title: "Issue", baseBranch: "main" });
  mocks.prepare.mockResolvedValue({ branch: "feature/issue-14", baseBranch: "main" });
  mocks.snapshot.mockResolvedValue({ fingerprint: "reviewed", summary: "1 file changed", hasChanges: true });
  mocks.publish.mockResolvedValue("https://github.com/owner/repo/pull/15");
  fixture(result("ready_to_publish"));
}
describe("durable Telegram worker", { timeout: 15_000 }, () => {
  it("recovers the old non-Git failure by preparing and validating before creating a branch", async () => {
    issueFixture();
    await seed({ kind: "issue", error: "fatal: not a git repository", issue: { owner: "owner", repo: "repo", number: 14, url: "https://github.com/owner/repo/issues/14" } });
    mocks.ensure.mockRejectedValueOnce(new Error("目标目录已有文件"));
    await dispatch("", "continue");
    const failed = await wait("failed");
    expect(failed.failedStage).toBe("preparing_repository");
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    await dispatch("", "continue");
    const recovered = await wait("awaiting_review");
    expect(recovered.id).toBe(failed.id); expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.ensure.mock.invocationCallOrder[1]).toBeLessThan(mocks.inspect.mock.invocationCallOrder[0]);
  });
  it("uses the prepared repository for SDK, Git and publication while preserving session scope", async () => {
    issueFixture();
    const target = path.join(directory, "owner", "repo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, ".env"), "OPENAI_API_KEY=target-private-secret-for-redaction\n");
    mocks.ensure.mockImplementation(async (_workspace, _issue, _signal, options) => {
      await options.beforePrepare?.(target); return target;
    });
    await dispatch("", "finishissue");
    await dispatch("[任务](https://github.com/owner/repo/issues/14?utm_source=telegram) 完成issue");
    const published = await wait("awaiting_review");
    expect(published.workspace).toBe(directory); expect(published.repositoryPath).toBe(target);
    expect(mocks.open).toHaveBeenCalledWith(undefined, { workspace: target });
    expect(mocks.inspect.mock.calls[0][1]).toBe(target);
    expect(mocks.prepare.mock.calls[0][0]).toBe(target);
    expect(mocks.snapshot.mock.calls[0][0]).toBe(target);
    expect(mocks.publish.mock.calls[0][0]).toBe(target);
    expect(mocks.ensure.mock.calls.at(-1)?.[3]).toMatchObject({ repositoryPath: target, requireExisting: true });
    const lock = reserve("available-after-delivery", target); lock.release();
    await dispatch("继续补文档"); await wait("awaiting_review");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: target });
  });
  it("does not recreate an executed repository or replay its turn when it disappeared", async () => {
    issueFixture();
    await seed({ kind: "issue", branch: "feature/issue-14", threadId: "stable-thread", issue: { owner: "owner", repo: "repo", number: 14, url: "https://github.com/owner/repo/issues/14", baseBranch: "main" } });
    mocks.ensure.mockRejectedValue(new Error("原任务的 Git 仓库已缺失"));
    await dispatch("", "continue"); await wait("failed");
    expect(mocks.ensure.mock.calls[0][3]).toMatchObject({ requireExisting: true });
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("answers greetings directly and continues the same thread with natural language", async () => {
    fixture("你好，有什么可以帮你？"); await dispatch("你好");
    const first = await wait("completed"); expect(first.question).toBeUndefined();
    expect(mocks.run.mock.calls[0][1].outputSchema).toBeUndefined();
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(credentials, "123", "你好，有什么可以帮你？"));
    fixture("我可以和你聊天，也可以按要求操作项目。"); await dispatch("你能做什么？");
    const next = await wait("completed"); expect(next.id).not.toBe(first.id);
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: directory });
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("danger-full-access");
  });
  it("sends acknowledgement before starting the worker", async () => {
    fixture("你好"); let acknowledged: (() => void) | undefined;
    const response = dispatchTelegram({ text: "你好", userId: "123", chatId: "123", workspace: directory, credentials, settingsKey: settingsKey(), reply: () => new Promise<void>(resolve => { acknowledged = resolve; }) });
    await vi.waitFor(() => expect(acknowledged).toBeDefined()); expect(mocks.open).not.toHaveBeenCalled();
    acknowledged!(); await response; await wait("completed");
  });
  it("keeps the original request and queued follow-up at a turn boundary", async () => {
    fixture("已处理"); const lock = reserve("other-owner", directory);
    try { await dispatch("原始任务"); await dispatch("补充要求"); expect((await current())?.pending).toEqual(["原始任务", "补充要求"]); }
    finally { lock.release(); }
    await wait("completed"); expect(mocks.run.mock.calls[0][0]).toContain("原始任务\n\n补充要求");
  });
  it("delivers an Issue PR automatically and rejects stale buttons", async () => {
    issueFixture(); await dispatch("", "finishissue"); await dispatch("https://github.com/owner/repo/issues/14");
    const published = await wait("awaiting_review");
    expect(published.prUrl).toMatch(/pull\/15$/); expect(published.question).toBeUndefined();
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(await dispatch("expired", "confirm", "expired")).toContain("过期");
  });
  it("asks only for missing Issue information and accepts a plain answer", async () => {
    issueFixture(); fixture(result("waiting_input", { text: "用哪个目录？", choices: ["src", "lib"], highRisk: true }));
    await dispatch("https://github.com/owner/repo/issues/14");
    const question = await wait("waiting_input"); expect(question.question?.highRisk).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
    fixture(result("ready_to_publish")); await dispatch("src"); await wait("awaiting_review");
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: directory });
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("回答问题");
  });
  it("keeps publish-time follow-ups on the same task, thread and PR without confirmation", async () => {
    issueFixture(); let finishPublish: ((value: string) => void) | undefined;
    mocks.publish.mockImplementationOnce(() => new Promise<string>(resolve => { finishPublish = resolve; }));
    await dispatch("https://github.com/owner/repo/issues/14");
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    const first = (await current())!; await dispatch("发布时追加：更新帮助文档");
    finishPublish!("https://github.com/owner/repo/pull/15"); const next = await wait("awaiting_review");
    expect(next.id).toBe(first.id); expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("发布时追加：更新帮助文档");
    expect(mocks.open).toHaveBeenLastCalledWith("stable-thread", { workspace: directory });
  });
  it("applies review-time feedback to the existing feature branch and PR", async () => {
    issueFixture(); await dispatch("https://github.com/owner/repo/issues/14"); const published = await wait("awaiting_review");
    await dispatch("修复 Review 中发现的边界情况"); await wait("awaiting_review");
    expect((await current())?.id).toBe(published.id); expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(2); expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("边界情况");
  });
  it("does not quarantine an SDK process that explicitly exited with code 1", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Codex Exec exited with code 1: Not inside a trusted directory"));
    await dispatch("你好"); const failed = await wait("failed");
    expect(failed.requiresStopCheck).toBe(false); expect(failed.stage).toBe("failed");
    const lock = reserve("after-exit", directory); lock.release();
    expect(await dispatch("", "new")).toContain("已开启新");
  });
  it("clears the pre-upgrade trusted-directory startup lock without blocking new conversation", async () => {
    await seed({ requiresStopCheck: true, error: "Codex Exec exited with code 1: Reading prompt from stdin... Not inside a trusted directory and --skip-git-repo-check was not specified" });
    fixture("这是上次启动失败，现在可以继续聊天。"); await dispatch("啥意思"); await wait("completed");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("drains a turn.failed stream before reporting the failure without a false stop lock", async () => {
    let drained = false;
    mocks.run.mockResolvedValueOnce({ events: (async function* () { yield { type: "turn.failed", error: { message: "登录已失效" } }; drained = true; })() });
    await dispatch("你好"); const task = await wait("failed");
    expect(drained).toBe(true); expect(task.requiresStopCheck).toBe(false);
    expect(task.error).toBe("登录已失效");
  });
  it("lets a follow-up ask about a failure without replaying the original task", async () => {
    await seed({ error: "Codex 登录已过期", threadId: "previous-thread", inFlight: ["删除旧文件"] });
    fixture("上次失败是因为登录过期，请在本机重新登录。"); await dispatch("啥意思？"); await wait("completed");
    const prompt = mocks.run.mock.calls[0][0]; expect(prompt).toContain("登录已过期"); expect(prompt).toContain("啥意思？");
    expect(prompt).not.toContain("删除旧文件"); expect(mocks.open).toHaveBeenCalledWith("previous-thread", { workspace: directory });
  });
  it("checks uncertain previous results on continue and does not accumulate default requests", async () => {
    await seed({ inFlight: ["已接受的补充要求"], threadId: "stable-thread", error: "进程启动失败" });
    const lock = reserve("hold", directory); fixture("恢复完成");
    try {
      await dispatch("", "continue"); await dispatch("", "continue");
      const task = (await current())!; expect(task.pending).toEqual(["检查上次任务和保留的工作区后继续，不要重复已经完成的操作。"]);
      expect(task.inFlight).toEqual([]); expect(task.recoveryContext).toContain("已接受的补充要求");
    } finally { lock.release(); }
    await wait("completed"); expect(mocks.run.mock.calls[0][0]).toContain("不能直接重复");
  });
  it("cleans stale stage, question and error when cancelling queued or waiting work", async () => {
    await seed({ status: "waiting_input", stage: "confirm_execution", error: "旧错误", question: { id: "old", text: "旧确认", highRisk: true } });
    await dispatch("", "cancel"); const cancelled = (await current())!;
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.stage).toBe("cancelled");
    expect(cancelled.error).toBeUndefined(); expect(cancelled.question).toBeUndefined();
    expect(await dispatch("", "new")).toContain("已开启新");
  });
  it("allows new to replace a clarification and keeps old confirmation IDs stale", async () => {
    await seed({ status: "waiting_input", stage: "waiting_input", question: { id: "old", text: "目录？" } });
    expect(await dispatch("", "new")).toContain("已开启新");
    expect(await dispatch("old", "confirm", "old")).toContain("过期");
  });
  it("retains a real abort lock until the user has checked local child processes", async () => {
    mocks.run.mockImplementation(async (_prompt: string, options: { signal: AbortSignal }) => ({ events: (async function* () {
      yield { type: "thread.started", thread_id: "stable-thread" };
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    })() }));
    await dispatch("长任务"); await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
    await dispatch("", "cancel"); const cancelled = await wait("cancelled");
    expect(cancelled.stage).toBe("cancelled"); expect(cancelled.error).toBeUndefined(); expect(cancelled.requiresStopCheck).toBe(true);
    expect(() => reserve("another-writer", directory)).toThrow("子进程");
    expect(await dispatch("", "new")).toContain("/new 也不能"); expect(await dispatch("", "continue")).toContain("已在本机确认停止");
    fixture("已核对上次结果并续接"); await dispatch("已在本机确认停止", "continue"); await wait("completed");
    const available = reserve("after-stop-check", directory); available.release();
  });
  it("never auto-replays an uncertain queued checkpoint after restart", async () => {
    await seed({ status: "queued", inFlight: ["未知是否送达的要求"], pending: [] });
    await recoverTelegramTasks(credentials, settingsKey());
    expect((await current())?.status).toBe("interrupted"); expect(mocks.open).not.toHaveBeenCalled();
  });
  it("refuses SDK writes when an existing Issue branch changed", async () => {
    issueFixture(); await seed({ kind: "issue", branch: "feature/issue-14", issue: { owner: "owner", repo: "repo", number: 14, url: "https://github.com/owner/repo/issues/14", baseBranch: "main" } });
    mocks.git.mockResolvedValue("main"); await dispatch("", "continue"); const failed = await wait("failed");
    expect(failed.error).toContain("分支已变化"); expect(mocks.open).not.toHaveBeenCalled();
  });
  it("marks dead runners interrupted on restart and retains unreconciled input", async () => {
    await seed({ status: "running", runner: { pid: 2147483647, host: os.hostname(), startedAt: new Date().toISOString() }, inFlight: ["重启前请求"] });
    await recoverTelegramTasks(credentials, settingsKey()); const interrupted = (await current())!;
    expect(interrupted.status).toBe("interrupted"); expect(interrupted.requiresStopCheck).toBe(true);
    expect(interrupted.inFlight).toEqual(["重启前请求"]); expect(mocks.open).not.toHaveBeenCalled();
  });
});
