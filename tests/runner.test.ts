import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { consumeStream } from "../src/lib/stream";
import { createChat, deleteChat, getChat, listChats } from "../src/lib/store";
import { isRunning, prepareTurn, recover, reserve, stop, streamTurn } from "../src/lib/runner";
import { persistSettings } from "../src/lib/config";
import { readableError } from "../src/lib/codex";
const sdk = vi.hoisted(() => ({ options: undefined as unknown, resumed: "", make: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class {
  startThread(options: unknown) { sdk.options = options; return { runStreamed: sdk.make }; }
  resumeThread(id: string, options: unknown) { sdk.resumed = id; return this.startThread(options); }
} }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "prbot-test-"));
  vi.stubEnv("PRBOT_DATA_DIR", directory); vi.stubEnv("CODEX_WORKSPACE", directory);
  sdk.resumed = ""; sdk.make.mockReset();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const completion: ThreadEvent = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 } };
function fixture(events: ThreadEvent[]) { sdk.make.mockImplementation(async () => ({ events: (async function* () { yield* events; })() })); }
async function run(id: string, prompt = "你好") {
  const prepared = await prepareTurn(id, prompt);
  await consumeStream(new Response(streamTurn(prepared, prompt, new AbortController().signal)), () => {});
  return getChat(id);
}
describe("Codex lifecycle and persistence", () => {
  it("streams text and file changes, persists the thread, and resumes with full access", async () => {
    const chat = await createChat();
    fixture([{ type: "thread.started", thread_id: "persisted-sdk-thread" }, { type: "item.updated", item: { id: "m", type: "agent_message", text: "半句" } }, { type: "item.completed", item: { id: "m", type: "agent_message", text: "完整回答" } }, { type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "app.ts", kind: "update" }], status: "completed" } }, completion]);
    const result = await run(chat.id);
    expect(result.messages[1]).toMatchObject({ text: "完整回答", status: "completed", activities: [{ title: "修改文件", detail: "update  app.ts" }] });
    expect(sdk.options).toMatchObject({ sandboxMode: "danger-full-access", approvalPolicy: "never", workingDirectory: directory });
    expect(isRunning(chat.id)).toBe(false);
    fixture([completion]); await run(chat.id, "继续");
    expect(sdk.resumed).toBe("persisted-sdk-thread");
    expect((await getChat(chat.id)).messages).toHaveLength(4);
  });
  it("applies a saved model to both new and resumed SDK threads", async () => {
    await persistSettings({ workspace: directory, model: "first-model", codexPath: "", codexHome: "", recentWorkspaces: [directory] });
    const chat = await createChat();
    fixture([{ type: "thread.started", thread_id: "model-switch-thread" }, completion]);
    await run(chat.id);
    expect(sdk.options).toMatchObject({ model: "first-model" });
    await persistSettings({ workspace: directory, model: "second-model", codexPath: "", codexHome: "", recentWorkspaces: [directory] });
    fixture([completion]); await run(chat.id, "换模型继续");
    expect(sdk.resumed).toBe("model-switch-thread");
    expect(sdk.options).toMatchObject({ model: "second-model", workingDirectory: directory });
  });
  it("rejects concurrent turns before adding another user message", async () => {
    const chat = await createChat(); const turn = await prepareTurn(chat.id, "一");
    try { await expect(prepareTurn(chat.id, "二")).rejects.toMatchObject({ status: 409 }); expect((await getChat(chat.id)).messages).toHaveLength(2); }
    finally { turn.release(); }
  });
  it("marks provider failures and releases its lock", async () => {
    const chat = await createChat(); fixture([{ type: "turn.failed", error: { message: "登录失效" } }]);
    const result = await run(chat.id);
    expect(result.messages[1]).toMatchObject({ status: "failed" }); expect(result.messages[1].error).toContain("登录失效");
    expect(isRunning(chat.id)).toBe(false);
  });
  it("does not treat truncated output as completed", async () => {
    const chat = await createChat(); fixture([]);
    expect((await run(chat.id)).messages[1]).toMatchObject({ status: "failed" });
  });
  it("cancels the SDK through AbortSignal, persists partial output, then permits a new turn", async () => {
    const chat = await createChat(); let signal: AbortSignal | undefined;
    sdk.make.mockImplementation(async (_: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return { events: (async function* () {
        yield { type: "item.updated", item: { id: "m", type: "agent_message", text: "部分回答" } } as ThreadEvent;
        stop(chat.id); options.signal.throwIfAborted();
      })() };
    });
    const result = await run(chat.id);
    expect(signal?.aborted).toBe(true); expect(result.messages[1]).toMatchObject({ text: "部分回答", status: "stopped" });
    fixture([completion]); expect((await run(chat.id, "继续")).messages[3].status).toBe("completed");
  });
  it("recovers interrupted messages after a process exit", async () => {
    const chat = await createChat(); const prepared = await prepareTurn(chat.id, "开始"); prepared.release();
    expect(recover(await getChat(chat.id)).messages[1].status).toBe("stopped");
  });
  it("allows deletion only when the run is not reserved", async () => {
    const chat = await createChat(); const lock = reserve(chat.id);
    expect(() => reserve(chat.id)).toThrow(); lock.release();
    await deleteChat(chat.id); expect(await listChats()).toEqual([]);
  });
  it("rejects path traversal", async () => expect(getChat("../../.env")).rejects.toMatchObject({ status: 404 }));
  it("redacts configured credentials in provider errors", () => {
    vi.stubEnv("CODEX_API_KEY", "private-test-key");
    expect(readableError(new Error("private-test-key sk-secret-token"))).not.toMatch(/private-test-key|sk-secret-token/);
  });
});
