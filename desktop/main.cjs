// Electron utility process + Next standalone; references and tradeoffs: docs/delivery.md.
const { app, BrowserWindow, dialog, utilityProcess, ipcMain } = require("electron");
const { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync, renameSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

app.setName("PRBOT");
if (process.env.PRBOT_DESKTOP_HOME) app.setPath("userData", path.resolve(process.env.PRBOT_DESKTOP_HOME));
let backend;
let window;
let quitting = false;
let startupStage = "准备用户目录";
let backendExitCode = null;

function reportStartupFailure() {
  const home = app.getPath("userData");
  const diagnostic = path.join(home, "startup-error.json");
  // A parser exception may contain .env/settings contents. Record stages, never raw errors.
  const record = { stage: startupStage, platform: process.platform, arch: process.arch,
    electron: process.versions.electron, backendExitCode, time: new Date().toISOString() };
  let recorded = false;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(diagnostic, JSON.stringify(record, null, 2), { mode: 0o600 });
    recorded = true;
  } catch { /* The user data directory itself may be unwritable. */ }
  dialog.showErrorBox("PRBOT 启动失败", `失败阶段：${startupStage}。\n系统：${process.platform} / ${process.arch}。${backendExitCode === null ? "" : `\n后台退出码：${backendExitCode}。`}\n${recorded ? `诊断记录：${diagnostic}` : "无法写入诊断记录，请检查用户目录写入权限。"}\n后台日志：${path.join(home, "server.log")}（本次后台启动前失败时可能是上次记录）。\n请检查 .env、settings.json 中的目录和端口；重新安装时请选择对应系统架构的安装包。`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { window.restore(); window.focus(); } });
  app.on("before-quit", () => { quitting = true; backend?.kill(); });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch(reportStartupFailure);
}

async function start() {
  const home = app.getPath("userData");
  mkdirSync(home, { recursive: true });
  startupStage = "读取用户 .env";
  // Only read runtime user configuration, never ship a developer's .env in an installer.
  const envFile = path.join(home, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  startupStage = "读取 settings.json";
  const settingsFile = path.join(home, "settings.json");
  const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  if (existsSync(settingsFile) && (saved.version !== 1 || typeof saved.workspace !== "string")) throw new Error("Invalid settings");
  let workspace = path.resolve(home, saved.workspace || process.env.CODEX_WORKSPACE || "workspace");
  startupStage = "选择工作目录";
  if (!saved.workspace && !process.env.CODEX_WORKSPACE) {
    const selected = await dialog.showOpenDialog({ title: "选择 PRBOT 项目目录", properties: ["openDirectory"] });
    if (!selected.canceled && selected.filePaths[0]) {
      workspace = selected.filePaths[0];
      // Only store non-sensitive preferences. Backend performs full validation before any task.
      const temp = `${settingsFile}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, workspace, recentWorkspaces: [workspace] }), { mode: 0o600 });
      renameSync(temp, settingsFile);
    } else mkdirSync(workspace, { recursive: true });
  }
  const server = path.join(process.resourcesPath, "server");
  startupStage = "检查服务端口";
  const port = Number(process.env.PRBOT_DESKTOP_PORT || 43127);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const instance = randomUUID();
  const origin = `http://127.0.0.1:${port}`;
  let exited = false;
  startupStage = "启动后台服务";
  backend = utilityProcess.fork(path.join(server, "server.js"), [], {
    cwd: home,
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1", PORT: String(port), PRBOT_INSTANCE_ID: instance,
      PRBOT_SETTINGS_FILE: settingsFile,
      CODEX_WORKSPACE: workspace, PRBOT_DATA_DIR: path.resolve(home, process.env.PRBOT_DATA_DIR || "chats") },
    stdio: "pipe", serviceName: "PRBOT local server",
  });
  // Overwrite per launch; keep startup failures inspectable without logging configuration.
  const log = createWriteStream(path.join(home, "server.log"), { flags: "w", mode: 0o600 });
  log.on("error", () => {});
  backend.stdout?.pipe(log, { end: false });
  backend.stderr?.pipe(log, { end: false });
  backend.on("exit", code => {
    backendExitCode = code;
    log.end();
    exited = true;
    if (window && !quitting) {
      dialog.showErrorBox("PRBOT 服务已停止", "本机服务意外退出，请重新打开程序。");
      app.quit();
    }
  });
  let ready = false;
  startupStage = "等待后台服务就绪";
  for (let attempt = 0; attempt < 120 && !exited; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (health.instance === instance) { ready = true; break; }
    } catch { /* Wait for our own backend, not an unrelated process on this port. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready || exited) throw new Error("Backend unavailable");
  startupStage = "打开应用窗口";
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 760, minHeight: 560,
    title: "PRBOT", icon: path.join(__dirname, "icons/icon.png"), backgroundColor: "#f7f7f5", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  // Existing Copy buttons need clipboard writes; reads and unrelated permissions stay denied.
  const canWriteClipboard = (permission, requestingOrigin) => permission === "clipboard-sanitized-write" && requestingOrigin === origin;
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    let requestingOrigin;
    try { requestingOrigin = new URL(details.requestingUrl).origin; } catch { /* deny */ }
    callback(canWriteClipboard(permission, requestingOrigin));
  });
  window.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => canWriteClipboard(permission, requestingOrigin));
  ipcMain.handle("prbot:choose-workspace", async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== `${origin}/`) throw new Error("Unsupported sender");
    const selected = await dialog.showOpenDialog(window, { title: "选择项目目录", properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
  await window.loadURL(origin);
}
