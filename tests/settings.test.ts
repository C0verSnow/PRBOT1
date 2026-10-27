import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publicConfig, readSettings, runtimeConfig, persistSettings } from "../src/lib/config";
import { PUT } from "../src/app/api/config/route";
import { prepareTurn, reserve } from "../src/lib/runner";
import { createChat } from "../src/lib/store";
import { changeSettings } from "../src/lib/runtime-state";
import { discoverModels } from "../src/lib/models";
let home: string;
let project: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "prbot-settings-")));
  project = path.join(home, "project"); await mkdir(project);
  vi.stubEnv("PRBOT_DATA_DIR", path.join(home, "chats"));
  vi.stubEnv("PRBOT_SETTINGS_FILE", path.join(home, "settings.json"));
  vi.stubEnv("CODEX_WORKSPACE", project);
  for (const key of ["CODEX_MODEL", "CODEX_HOME", "CODEX_PATH_OVERRIDE", "CODEX_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
function update(data: unknown, headers: Record<string, string> = {}) {
  return PUT(new Request("http://127.0.0.1/api/config", { method: "PUT", headers: { host: "127.0.0.1", ...headers }, body: JSON.stringify(data) }));
}
describe("persistent runtime preferences", () => {
  it("loads project .env without leaking keys or replacing server routing", async () => {
    await writeFile(path.join(project, ".env"), 'CODEX_MODEL=project-model\nCODEX_API_KEY=project-private-key\nPORT=9876\n');
    const config = await runtimeConfig();
    expect(config.model).toBe("project-model"); expect(config.env.CODEX_API_KEY).toBe("project-private-key");
    expect(config.env.PORT).not.toBe("9876");
    expect(JSON.stringify(await publicConfig())).not.toContain("project-private-key");
    vi.stubEnv("CODEX_MODEL", "environment-model"); expect((await runtimeConfig()).model).toBe("environment-model");
    await persistSettings({ workspace: project, model: "saved-model", codexPath: "", codexHome: "", recentWorkspaces: [project] });
    expect((await runtimeConfig()).model).toBe("saved-model");
    expect(await readFile(path.join(home, "settings.json"), "utf8")).not.toContain("private-key");
  });
  it("atomically saves, recovers without cache, and rejects credentials", async () => {
    const next = path.join(home, "next"); await mkdir(next);
    expect((await update({ workspace: next, model: "" })).status).toBe(200);
    vi.stubEnv("CODEX_WORKSPACE", project);
    expect((await publicConfig()).workspace).toBe(next);
    expect((await readSettings()).recentWorkspaces).toEqual([next]);
    const original = await readFile(path.join(home, "settings.json"), "utf8");
    expect((await update({ CODEX_API_KEY: "do-not-store" })).status).toBe(400);
    expect(await readFile(path.join(home, "settings.json"), "utf8")).toBe(original);
  });
  it("rejects invalid directories, relative paths and executable overrides before saving", async () => {
    for (const input of [{ workspace: "relative" }, { workspace: path.join(home, "missing") }, { workspace: path.join(project, ".env") }, { codexPath: path.join(home, "missing") }, { codexHome: "relative" }]) {
      expect((await update(input)).status).toBe(400);
    }
    await expect(access(path.join(home, "settings.json"))).rejects.toBeDefined();
  });
  it("keeps corrupt preferences intact and reports them", async () => {
    await writeFile(path.join(home, "settings.json"), "{broken");
    await expect(publicConfig()).rejects.toThrow("原文件已保留");
    expect((await update({ model: "" })).status).toBe(500);
    expect(await readFile(path.join(home, "settings.json"), "utf8")).toBe("{broken");
  });
  it("blocks settings during any task and task admission during settings writes", async () => {
    const lock = reserve("other-chat");
    try { expect((await update({ model: "" })).status).toBe(409); } finally { lock.release(); }
    await changeSettings(async () => { expect(() => reserve("new-chat")).toThrow("正在保存设置"); });
    const available = reserve("new-chat"); available.release();
  });
  it("rejects cross-project resume before adding a message", async () => {
    const chat = await createChat(); const first = await prepareTurn(chat.id, "first"); first.release();
    const next = path.join(home, "other-project"); await mkdir(next);
    expect((await update({ workspace: next, model: "" })).status).toBe(200);
    await expect(prepareTurn(chat.id, "continue")).rejects.toMatchObject({ status: 409 });
  });
  it("blocks cross-origin settings updates", async () => {
    expect((await update({ model: "" }, { origin: "https://example.com" })).status).toBe(403);
  });
});
describe("official app-server discovery transport", () => {
  beforeEach(() => vi.stubEnv("CODEX_PATH_OVERRIDE", path.resolve("scripts/fake-codex.mjs")));
  it("initializes, paginates and filters hidden models from the actual subprocess", async () => {
    const models = await discoverModels();
    expect(models.map(m => m.id)).toEqual(["fixture-default", "fixture-secondary"]);
    expect(models[1].efforts).toEqual(["low", "high"]);
    expect(models[1].speeds).toEqual([{ id: "priority", name: "Fast" }]);
    expect((await update({ model: "fixture-secondary", effort: "medium" })).status).toBe(400);
    expect((await update({ model: "fixture-secondary", speed: "flex" })).status).toBe(400);
    const response = await update({ model: "fixture-secondary", effort: "high", speed: "priority" });
    expect(response.status).toBe(200); expect((await publicConfig()).modelId).toBe("fixture-secondary");
    expect(await readSettings()).toMatchObject({ effort: "high", speed: "priority" });
    expect((await update({ model: "not-in-catalog" })).status).toBe(400);
    expect((await publicConfig()).modelId).toBe("fixture-secondary");
  });
  it("reports discovery failure without changing the saved model", async () => {
    vi.stubEnv("PRBOT_TEST_MODELS_FAILURE", "1");
    await expect(discoverModels()).rejects.toMatchObject({ status: 502 });
    expect((await update({ model: "fixture-secondary" })).status).toBe(502);
    await expect(access(path.join(home, "settings.json"))).rejects.toBeDefined();
  });
});
