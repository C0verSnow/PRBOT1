import { access, readFile, realpath, stat, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "./http";
import type { AppSettings } from "./types";

export function dataDirectory() {
  return path.resolve(/* turbopackIgnore: true */ process.env.PRBOT_DATA_DIR || ".data");
}
export function settingsFile() {
  return path.resolve(/* turbopackIgnore: true */ process.env.PRBOT_SETTINGS_FILE || path.join(dataDirectory(), "settings.json"));
}
export async function directory(value: string, label = "项目目录") {
  if (!path.isAbsolute(value)) throw new HttpError(400, `${label}请填写绝对路径`);
  try {
    const target = await realpath(/* turbopackIgnore: true */ value);
    if (!(await stat(target)).isDirectory()) throw new Error();
    await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
    return target;
  } catch { throw new HttpError(400, `${label}不存在或没有读写权限`); }
}
export async function readSettings(): Promise<Partial<AppSettings>> {
  try {
    const value = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (!value || value.version !== 1 || typeof value !== "object" || Array.isArray(value)) throw new Error();
    for (const key of ["workspace", "model", "codexPath", "codexHome"])
      if (value[key] !== undefined && typeof value[key] !== "string") throw new Error();
    if (value.recentWorkspaces !== undefined && (!Array.isArray(value.recentWorkspaces) || value.recentWorkspaces.some((p: unknown) => typeof p !== "string"))) throw new Error();
    return { workspace: value.workspace, model: value.model, codexPath: value.codexPath, codexHome: value.codexHome, recentWorkspaces: value.recentWorkspaces };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new HttpError(500, "设置文件无法读取或格式不正确，请修复 settings.json 后重试；原文件已保留");
  }
}
export async function runtimeConfig(overrides: Partial<AppSettings> = {}) {
  const saved = { ...await readSettings(), ...overrides };
  const workspace = await directory(path.resolve(/* turbopackIgnore: true */ saved.workspace || process.env.CODEX_WORKSPACE || process.cwd()));
  let project: Record<string, string | undefined> = {};
  try { project = parseEnv(await readFile(path.join(workspace, ".env"), "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(400, "项目 .env 无法读取，请检查格式和权限");
  }
  const model = saved.model ?? (process.env.CODEX_MODEL || project.CODEX_MODEL || "");
  const codexPath = saved.codexPath ?? (process.env.CODEX_PATH_OVERRIDE || project.CODEX_PATH_OVERRIDE || "");
  const codexHome = saved.codexHome ?? (process.env.CODEX_HOME || project.CODEX_HOME || "");
  if (model.length > 200 || /[\s\x00-\x1f]/.test(model)) throw new HttpError(400, "模型标识格式不正确，请重新选择");
  if (codexPath) {
    if (!path.isAbsolute(codexPath)) throw new HttpError(400, "Codex 程序请填写绝对路径");
    try {
      if (!(await stat(/* turbopackIgnore: true */ codexPath)).isFile()) throw new Error();
      await access(codexPath, process.platform === "win32" ? constants.R_OK : constants.X_OK);
    } catch { throw new HttpError(400, "Codex 程序不存在或不能执行"); }
  }
  if (codexHome) await directory(codexHome, "Codex 配置目录");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Project files can provide Codex credentials/config, never change app routing/data paths.
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY"]) env[key] = process.env[key] || project[key] || "";
  if (codexHome) env.CODEX_HOME = codexHome;
  else delete env.CODEX_HOME;
  return { workspace, model, codexPath, codexHome, env, recentWorkspaces: saved.recentWorkspaces || [] };
}
export async function workspace() { return (await runtimeConfig()).workspace; }
export async function publicConfig() {
  const { workspace, model, codexPath, codexHome, recentWorkspaces } = await runtimeConfig();
  return { workspace, model: model || "Codex 默认模型", modelId: model, codexPath, codexHome, recentWorkspaces, access: "danger-full-access" as const };
}
// Borrowed design: electron-store's small versioned JSON + atomic replacement; see docs/settings.md.
export async function persistSettings(settings: AppSettings) {
  const target = settingsFile();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, ...settings }, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, target);
  } finally { await unlink(tmp).catch(() => {}); }
}
