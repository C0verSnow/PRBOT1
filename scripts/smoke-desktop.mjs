// Remote CI only. Launch the application extracted/installed from the delivery artifact.
import { _electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readdir, copyFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const executablePath = process.env.APP_EXECUTABLE;
const resources = process.env.APP_RESOURCES;
if (!executablePath || !resources) throw new Error("Installed application paths required");
const home = await mkdtemp(path.join(tmpdir(), "prbot-desktop-"));
const server = path.join(resources, "server");
const sdk = await import(pathToFileURL(path.join(server, "node_modules/@openai/codex-sdk/dist/index.js")));
new sdk.Codex(); // Assert dynamic native package resolution from the actual installed resources.
const openai = path.join(server, "node_modules/@openai");
const files = await readdir(openai, { recursive: true });
const binary = files.find(p => p.includes(`vendor${path.sep}`) && ["codex", "codex.exe"].includes(path.basename(p)));
if (!binary) throw new Error("Installed Codex executable missing");
console.log(execFileSync(path.join(openai, binary), ["--version"], { encoding: "utf8" }));
await mkdir("test-results/desktop", { recursive: true });
const env = { ...process.env, PRBOT_DESKTOP_HOME: home, CODEX_WORKSPACE: "", PRBOT_DATA_DIR: "",
  CODEX_API_KEY: "", OPENAI_API_KEY: "", CODEX_HOME: path.join(home, "codex") };
const launch = () => _electron.launch({ executablePath, args: process.platform === "linux" ? ["--no-sandbox"] : [], env, timeout: 60_000 });
async function close(application) {
  let timer;
  try {
    await Promise.race([application.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Installed application did not quit within 10 seconds")), 10_000);
    })]);
  } catch (error) {
    const pid = application.process().pid;
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else application.process().kill("SIGKILL");
    throw error;
  } finally { clearTimeout(timer); }
}
let application;
try {
  application = await launch();
  let page = await application.firstWindow({ timeout: 60_000 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("想法");
  const config = await (await page.request.get(new URL("/api/config", page.url()).href)).json();
  expect(config.workspace).toBe(await realpath(path.join(home, "workspace")));
  await page.evaluate(() => navigator.clipboard.writeText("PRBOT copy regression"));
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe("PRBOT copy regression");
  const created = await page.request.post(new URL("/api/chats", page.url()).href);
  expect(created.status()).toBe(201);
  const chat = await created.json();
  const textbox = page.getByRole("textbox", { name: "发送给 Codex 的消息" });
  await textbox.fill("安装包草稿恢复");
  await page.screenshot({ path: "test-results/desktop/installed.png", fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
  await close(application);
  application = undefined;
  await expect.poll(async () => {
    try { await fetch("http://127.0.0.1:43127/api/health"); return false; } catch { return true; }
  }).toBe(true);
  application = await launch();
  page = await application.firstWindow({ timeout: 60_000 });
  await expect(page.getByRole("textbox", { name: "发送给 Codex 的消息" })).toHaveValue("安装包草稿恢复");
  const chats = await (await page.request.get(new URL("/api/chats", page.url()).href)).json();
  expect(chats.some(c => c.id === chat.id)).toBe(true);
  console.log("Installed application: UI, API, native CLI, shutdown and restart persistence passed");
} finally {
  await (application ? close(application).catch(error => console.error(error.message)) : Promise.resolve());
  await copyFile(path.join(home, "server.log"), "test-results/desktop/server.log").catch(() => {});
}
