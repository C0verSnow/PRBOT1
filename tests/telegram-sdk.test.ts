import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openThread } from "../src/lib/codex";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "prbot-telegram-sdk-"));
  vi.stubEnv("PRBOT_DATA_DIR", path.join(directory, "data")); vi.stubEnv("CODEX_WORKSPACE", directory);
  vi.stubEnv("PRBOT_SETTINGS_FILE", path.join(directory, "settings.json"));
  vi.stubEnv("CODEX_PATH_OVERRIDE", path.resolve("scripts/fake-codex.mjs")); vi.stubEnv("CODEX_HOME", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
describe("Telegram through the actual SDK subprocess transport (remote CI fixture)", () => {
  it("uses the remote sandbox/network policy, emits events, writes a file and resumes its thread", async () => {
    const thread = await openThread(undefined, { workspace: directory });
    const first = await thread.run("写入测试文件");
    expect(JSON.parse(first.finalResponse)).toMatchObject({ status: "completed", summary: "远程任务已处理" });
    expect(await readFile(path.join(directory, "sdk-evidence.txt"), "utf8")).toContain("written through SDK subprocess");
    expect(first.items.some(item => item.type === "command_execution")).toBe(true);
    expect(thread.id).toBeTruthy();
    const resumed = await openThread(thread.id!, { workspace: directory });
    const next = await resumed.run("继续原来的任务");
    expect(resumed.id).toBe(thread.id);
    expect(JSON.parse(next.finalResponse).summary).toBe("远程原线程已继续");
  });
});
