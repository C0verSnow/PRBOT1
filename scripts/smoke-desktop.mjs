// Remote CI only. Launch the application extracted/installed from the delivery artifact.
import { _electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readdir, copyFile, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const executablePath = process.env.APP_EXECUTABLE;
const resources = process.env.APP_RESOURCES;
if (!executablePath || !resources) throw new Error("Installed application paths required");
const home = await mkdtemp(path.join(tmpdir(), "prbot-desktop-"));
const initial = path.join(home, "initial-project");
const selected = path.join(home, "selected-project");
await mkdir(initial); await mkdir(selected); await mkdir(path.join(home, "codex"));
// Verify startup reads the user .env without requiring an interactive CI picker.
await writeFile(path.join(home, ".env"), `CODEX_WORKSPACE="${initial}"\n`);
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
delete env.CODEX_WORKSPACE;
delete env.CODEX_PATH_OVERRIDE;
delete env.CODEX_MODEL;
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
  expect(config.workspace).toBe(await realpath(initial));
  expect(await page.locator(".brand-mark img").evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const models = await page.request.get(new URL("/api/models", page.url()).href);
  expect(models.status(), await models.text()).toBe(200);
  expect((await models.json()).models.length).toBeGreaterThan(0);
  // Exercise the restricted preload -> IPC -> native dialog path, with OS UI result controlled by CI.
  await application.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }); }, selected);
  await page.locator(".workspace-button").click();
  const settings = page.getByRole("dialog", { name: "工作空间" });
  await settings.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "项目目录", exact: true })).toHaveValue(selected);
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(settings).not.toBeVisible();
  expect((await (await page.request.get(new URL("/api/config", page.url()).href)).json()).workspace).toBe(await realpath(selected));
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")).workspace).toBe(await realpath(selected));
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.locator(".workspace-button").click();
  await settings.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "项目目录", exact: true })).toHaveValue(await realpath(selected));
  await page.screenshot({ path: "test-results/desktop/settings.png", fullPage: true, animations: "disabled" });
  await settings.getByRole("button", { name: "取消", exact: true }).click();
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
  const restored = await (await page.request.get(new URL("/api/config", page.url()).href)).json();
  expect(restored.workspace).toBe(await realpath(selected));
  expect(restored.recentWorkspaces).toContain(await realpath(selected));
  const chats = await (await page.request.get(new URL("/api/chats", page.url()).href)).json();
  expect(chats.some(c => c.id === chat.id)).toBe(true);
  console.log("Installed application: UI, API, native CLI, shutdown and restart persistence passed");
} finally {
  await (application ? close(application).catch(error => console.error(error.message)) : Promise.resolve());
  await copyFile(path.join(home, "server.log"), "test-results/desktop/server.log").catch(() => {});
}
