import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import path from "node:path";
import { existsSync } from "node:fs";
import { runtimeConfig } from "./config";
import { HttpError } from "./http";
import type { AppSettings, CodexModel } from "./types";

// Official stdio JSON-RPC handshake/model/list, no private SDK fields or hardcoded catalog.
// https://learn.chatgpt.com/docs/app-server#list-models-modellist
export async function discoverModels(overrides: Partial<AppSettings> = {}): Promise<CodexModel[]> {
  const config = await runtimeConfig(overrides);
  const args = ["app-server"];
  let command = config.codexPath;
  if (!command) {
    // Resolve the CLI declared by our exact SDK dependency, including installed standalone resources.
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const sdkRequire = createRequire(require.resolve("@openai/codex-sdk"));
    const cli = sdkRequire.resolve("@openai/codex/package.json");
    const targets: Record<string, string> = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" };
    const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "";
    if (!architecture || !targets[process.platform]) throw new HttpError(502, "当前系统没有支持的 Codex 程序");
    const cliRequire = createRequire(cli);
    const platformPackage = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const vendor = path.join(path.dirname(platformPackage), "vendor", `${architecture}-${targets[process.platform]}`);
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    command = [path.join(vendor, "bin", name), path.join(vendor, "codex", name)].find(existsSync) || "";
    if (!command) throw new HttpError(502, "内置 Codex 程序缺失，请重新安装 PRBOT");
  }
  const child = spawn(command, args, { cwd: config.workspace, env: config.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  const unavailable = () => new HttpError(502, "无法读取 Codex 模型列表，请检查登录、网络和 Codex 程序，点击刷新重试");
  let sequence = 0;
  let failed = false;
  const fail = () => { failed = true; for (const request of pending.values()) request.reject(unavailable()); pending.clear(); };
  const timeout = setTimeout(() => { fail(); child.kill(); }, 15_000);
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stderr.resume(); // Never relay potentially credential-bearing CLI diagnostics to clients.
  lines.on("line", line => {
    if (line.length > 2_000_000) { fail(); child.kill(); return; }
    try {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(unavailable()); else request.resolve(message.result);
    } catch { fail(); }
  });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  function rpc(method: string, params: unknown): Promise<unknown> {
    if (failed) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); send({ id, method, params }); });
  }
  try {
    await rpc("initialize", { clientInfo: { name: "prbot", title: "PRBOT", version: "0.1.0" } });
    send({ method: "initialized", params: {} });
    const models = new Map<string, CodexModel>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await rpc("model/list", { limit: 100, includeHidden: false, cursor }) as { data?: unknown[]; nextCursor?: string | null };
      if (!result || !Array.isArray(result.data)) throw unavailable();
      for (const entry of result.data) {
        const item = entry as Record<string, unknown>;
        if (item && item.hidden !== true && typeof item.model === "string" && item.model && !/[\s\x00-\x1f]/.test(item.model)) {
          models.set(item.model, { id: item.model, name: typeof item.displayName === "string" ? item.displayName : item.model, isDefault: item.isDefault === true });
        }
      }
      if (!result.nextCursor) { if (!models.size) throw unavailable(); return [...models.values()]; }
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) throw unavailable();
      cursor = result.nextCursor;
    }
    throw unavailable();
  } finally { clearTimeout(timeout); lines.close(); fail(); child.stdin.destroy(); child.kill(); }
}
