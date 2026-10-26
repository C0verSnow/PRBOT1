import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function workspace() {
  const target = await realpath(path.resolve(process.env.CODEX_WORKSPACE || process.cwd()));
  if (!(await stat(target)).isDirectory()) throw new Error("CODEX_WORKSPACE 必须是存在的项目目录");
  return target;
}
export function dataDirectory() {
  return path.resolve(process.env.PRBOT_DATA_DIR || ".data");
}
export async function publicConfig() {
  return { workspace: await workspace(), model: process.env.CODEX_MODEL || "Codex 默认模型", access: "danger-full-access" as const };
}
