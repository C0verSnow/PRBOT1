import { directory, publicConfig, runtimeConfig, persistSettings } from "@/lib/config";
import { body, guard, failure, HttpError } from "@/lib/http";
import { changeSettings } from "@/lib/runtime-state";
import { discoverModels } from "@/lib/models";
import type { AppSettings } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json(await publicConfig()); } catch (e) { return failure(e); }
}
export async function PUT(request: Request) {
  try {
    guard(request);
    const input = await body(request);
    if (Object.keys(input).some(key => !["workspace", "model", "codexPath", "codexHome", "effort", "speed"].includes(key))) throw new HttpError(400, "设置中包含不支持的内容，密钥请放入 .env");
    const update: Partial<AppSettings> = {};
    for (const key of ["workspace", "model", "codexPath", "codexHome", "effort", "speed"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== "string" || input[key].length > 4096) throw new HttpError(400, "设置格式不正确");
      update[key] = input[key].trim();
    }
    return Response.json(await changeSettings(async () => {
      if (update.workspace !== undefined) update.workspace = await directory(update.workspace);
      const config = await runtimeConfig(update);
      if (config.model || config.effort || config.speed) {
        const models = await discoverModels(update);
        const selected = config.model ? models.find(model => model.id === config.model) : models.find(model => model.isDefault);
        if (!selected) throw new HttpError(400, "所选模型已不在 Codex 列表中，请刷新并重新选择");
        if (config.effort && !selected.efforts.includes(config.effort)) throw new HttpError(400, "所选模型不支持此推理强度，请刷新并重新选择");
        if (config.speed && config.speed !== "default" && !selected.speeds.some(tier => tier.id === config.speed)) throw new HttpError(400, "所选模型不支持此速度档位，请刷新并重新选择");
      }
      await persistSettings({ workspace: config.workspace, model: config.model, effort: config.effort, speed: config.speed, codexPath: config.codexPath, codexHome: config.codexHome,
        recentWorkspaces: [config.workspace, ...config.recentWorkspaces.filter(p => p !== config.workspace)].slice(0, 10) });
      return publicConfig();
    }));
  } catch (e) { return failure(e); }
}
