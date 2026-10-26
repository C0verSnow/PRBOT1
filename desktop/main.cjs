// Electron utility process + Next standalone; references and tradeoffs: docs/delivery.md.
const { app, BrowserWindow, dialog, utilityProcess } = require("electron");
const { mkdirSync, existsSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

if (process.env.PRBOT_DESKTOP_HOME) app.setPath("userData", path.resolve(process.env.PRBOT_DESKTOP_HOME));
let backend;
let window;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { window.restore(); window.focus(); } });
  app.on("before-quit", () => { quitting = true; backend?.kill(); });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox("PRBOT 启动失败", "请检查用户配置 .env 中的目录和端口。关闭占用端口的程序后重试。");
    app.quit();
  });
}

async function start() {
  const home = app.getPath("userData");
  mkdirSync(home, { recursive: true });
  // Only read runtime user configuration, never ship a developer's .env in an installer.
  const envFile = path.join(home, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const workspace = process.env.CODEX_WORKSPACE || path.join(home, "workspace");
  if (!process.env.CODEX_WORKSPACE) mkdirSync(workspace, { recursive: true });
  const server = path.join(process.resourcesPath, "server");
  const port = Number(process.env.PRBOT_DESKTOP_PORT || 43127);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const instance = randomUUID();
  const origin = `http://127.0.0.1:${port}`;
  let exited = false;
  backend = utilityProcess.fork(path.join(server, "server.js"), [], {
    cwd: home,
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1", PORT: String(port), PRBOT_INSTANCE_ID: instance,
      CODEX_WORKSPACE: workspace, PRBOT_DATA_DIR: path.resolve(process.env.PRBOT_DATA_DIR || path.join(home, "chats")) },
    stdio: "ignore", serviceName: "PRBOT local server",
  });
  backend.on("exit", () => {
    exited = true;
    if (window && !quitting) {
      dialog.showErrorBox("PRBOT 服务已停止", "本机服务意外退出，请重新打开程序。");
      app.quit();
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !exited; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (health.instance === instance) { ready = true; break; }
    } catch { /* Wait for our own backend, not an unrelated process on this port. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready || exited) throw new Error("Backend unavailable");
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 760, minHeight: 560,
    title: "PRBOT", backgroundColor: "#f7f7f5", autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  await window.loadURL(origin);
}
