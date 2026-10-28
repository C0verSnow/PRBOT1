import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
const runtimeRequire = createRequire(import.meta.url);
const secret = "fixture-sensitive-value";
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "prbot-startup-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it.each([
  ["env", "读取用户 .env"],
  ["settings", "读取 settings.json"],
  ["port", "检查服务端口"],
  ["backend", "等待后台服务就绪"],
])("startup failure in %s reports the stage without exposing configuration", async (failure, stage) => {
  if (failure === "env") await writeFile(path.join(home, ".env"), `KEY=${secret}`);
  if (failure === "settings") await writeFile(path.join(home, "settings.json"), `{"key":"${secret}`);
  const quit = vi.fn();
  const showErrorBox = vi.fn();
  const fork = vi.fn(() => {
    const backend = Object.assign(new EventEmitter(), { kill: vi.fn(), stdout: null, stderr: null });
    queueMicrotask(() => backend.emit("exit", 77));
    return backend;
  });
  const electron = {
    app: { setName: vi.fn(), requestSingleInstanceLock: () => true, on: vi.fn(),
      whenReady: () => Promise.resolve(), getPath: () => home, quit },
    dialog: { showErrorBox }, utilityProcess: { fork },
  };
  const source = await readFile("desktop/main.cjs", "utf8");
  runInNewContext(source, {
    require: (name: string) => name === "electron" ? electron : name === "node:fs"
      ? { ...fs, createWriteStream: () => new PassThrough() } : runtimeRequire(name),
    process: { platform: "darwin", arch: "arm64", versions: { electron: "45.0.0" },
      resourcesPath: path.join(home, "resources"), env: { CODEX_WORKSPACE: home, PRBOT_DESKTOP_PORT: failure === "port" ? "bad-port" : "43127" },
      loadEnvFile: () => { throw new Error(`Cannot parse ${secret}`); } },
    __dirname: path.resolve("desktop"), AbortSignal,
    fetch: async () => { throw new Error("Backend unavailable"); },
    setTimeout: (callback: () => void) => queueMicrotask(callback),
  });
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  const recorded = await readFile(path.join(home, "startup-error.json"), "utf8");
  expect(JSON.parse(recorded)).toMatchObject({ stage, platform: "darwin", arch: "arm64", backendExitCode: failure === "backend" ? 77 : null });
  expect(recorded).not.toContain(secret);
  expect(showErrorBox).toHaveBeenCalledWith("PRBOT 启动失败", expect.stringContaining(stage));
  expect(JSON.stringify(showErrorBox.mock.calls)).not.toContain(secret);
  expect(showErrorBox.mock.calls[0][1]).toContain(path.join(home, "startup-error.json"));
  expect(fork).toHaveBeenCalledTimes(failure === "backend" ? 1 : 0);
});
