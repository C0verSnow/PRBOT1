import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { HttpError } from "./http";

export interface TelegramSettings {
  projectId: string;
  clientId: string;
  clientSecret: string;
  environment: string;
  allowedUsers: string;
  enabled: boolean;
}
const file = () => path.join(dataDirectory(), "telegram-settings.json");
export async function readTelegramSettings(): Promise<TelegramSettings | null> {
  try {
    const value = JSON.parse(await readFile(file(), "utf8"));
    if (!value || typeof value !== "object" || ["projectId", "clientId", "clientSecret", "environment", "allowedUsers"].some(k => typeof value[k] !== "string") || typeof value.enabled !== "boolean") throw new Error();
    return value as TelegramSettings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HttpError(500, "Telegram 设置文件无法读取或格式不正确，原文件已保留");
  }
}
export function publicTelegramSettings(value: TelegramSettings | null) {
  return { projectId: value?.projectId || "", clientId: value?.clientId || "", environment: value?.environment || "prod", allowedUsers: value?.allowedUsers || "", enabled: value?.enabled || false, hasClientSecret: !!value?.clientSecret };
}
export async function saveTelegramSettings(input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !["projectId", "clientId", "clientSecret", "environment", "allowedUsers", "enabled"].includes(k))) throw new HttpError(400, "Telegram 设置包含不支持的内容");
  const old = await readTelegramSettings();
  for (const key of ["projectId", "clientId", "clientSecret", "environment", "allowedUsers"]) {
    if (typeof input[key] !== "string" || (input[key] as string).length > 4096) throw new HttpError(400, "Telegram 设置格式不正确");
  }
  if (typeof input.enabled !== "boolean") throw new HttpError(400, "Telegram 开关格式不正确");
  const value: TelegramSettings = {
    projectId: (input.projectId as string).trim(), clientId: (input.clientId as string).trim(),
    clientSecret: (input.clientSecret as string).trim() || old?.clientSecret || "",
    environment: (input.environment as string).trim(), allowedUsers: (input.allowedUsers as string).trim(), enabled: input.enabled,
  };
  if (value.enabled && (!value.projectId || !value.clientId || !value.clientSecret || !value.environment || !/^\d+(\s*,\s*\d+)*$/.test(value.allowedUsers))) throw new HttpError(400, "启用前请填写 Infisical 凭据、环境和 Telegram 用户 ID（多个用逗号分开）");
  if (value.environment && !/^[a-zA-Z0-9_-]+$/.test(value.environment)) throw new HttpError(400, "Infisical 环境格式不正确");
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, file()); }
  finally { await unlink(tmp).catch(() => {}); }
  return publicTelegramSettings(value);
}
