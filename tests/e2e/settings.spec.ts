import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
test("model discovery, persistence and actual SDK model argument agree", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "发送给 Codex 的消息" })).toBeEnabled();
  await page.locator(".workspace-button").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  const nav = settings.getByRole("navigation", { name: "设置分类" });
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: "工作空间" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "Codex 运行设置" }).click();
  const picker = settings.getByRole("combobox", { name: "当前模型", exact: true });
  await expect(picker).toBeEnabled();
  await picker.selectOption("fixture-secondary");
  await settings.getByRole("combobox", { name: "Effort" }).selectOption("high");
  await settings.getByRole("combobox", { name: "Speed" }).selectOption("priority");
  await expect(settings.getByText("Codex 设置已自动保存")).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await expect(settings).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".model-name")).toHaveText("fixture-secondary");
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill("写入测试文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("你好！我已连接到当前项目。")).toBeVisible();
  const evidence = await readFile(path.resolve(".data/workspace/sdk-evidence.txt"), "utf8");
  expect(evidence).toContain("model=fixture-secondary");
  expect(evidence).toContain('model_reasoning_effort="high"');
  expect(evidence).toContain('service_tier="priority"');
  await page.locator(".workspace-button").click();
  await settings.getByRole("navigation").getByRole("button", { name: "Codex 运行设置" }).click();
  await expect(picker).toHaveValue("fixture-secondary");
  await expect(settings.getByRole("combobox", { name: "Effort" })).toHaveValue("high");
  await expect(settings.getByRole("combobox", { name: "Speed" })).toHaveValue("priority");
  await page.screenshot({ path: info.outputPath("workspace-settings.png"), fullPage: true, animations: "disabled" });
  await picker.selectOption("");
  await expect(settings.getByText("Codex 设置已自动保存")).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();
});
test("settings cannot change while a task is running and failures remain actionable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill("长任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("正在执行长任务")).toBeVisible();
  await page.locator(".workspace-button").click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  await page.route("**/api/models", route => route.fulfill({ status: 502, json: { error: "模型读取失败，请刷新重试" } }));
  await page.locator(".workspace-button").click();
  await dialog.getByRole("navigation").getByRole("button", { name: "Codex 运行设置" }).click();
  await expect(dialog.getByRole("alert")).toContainText("请刷新重试");
  await page.unroute("**/api/models");
  await dialog.getByRole("button", { name: "刷新模型", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "当前模型", exact: true })).toBeEnabled();
});

// Cover the bundled native lookup in production code, beyond the deterministic fixture path.
test("production server discovers models with its actual bundled Codex", async ({ request }) => {
  const update = (codexPath: string) => request.put("/api/config", { data: { model: "", codexPath } });
  try {
    expect((await update("")).status()).toBe(200);
    const response = await request.get("/api/models");
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).models.length).toBeGreaterThan(0);
  } finally {
    expect((await update(path.resolve("scripts/fake-codex.mjs"))).status()).toBe(200);
  }
});
test("Telegram settings save without showing the stored client secret", async ({ page }) => {
  await page.goto("/");
  const loaded = page.waitForResponse(response => response.url().endsWith("/api/telegram/settings") && response.request().method() === "GET");
  await page.locator(".workspace-button").click();
  await loaded;
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("navigation").getByRole("button", { name: "Infisical" }).click();
  await dialog.getByLabel("Infisical Project ID").fill("fixture-project");
  await dialog.getByLabel("Infisical Client ID").fill("fixture-client");
  await dialog.getByLabel("Infisical Client Secret").fill("fixture-secret");
  await dialog.getByRole("navigation").getByRole("button", { name: "Telegram", exact: true }).click();
  await dialog.getByLabel("允许的 Telegram 用户 ID（逗号分隔）").fill("123456");
  await dialog.getByRole("button", { name: "保存 Telegram 与 Infisical 设置" }).click();
  await expect(dialog.getByText("Telegram 设置已保存")).toBeVisible();
  await dialog.getByRole("navigation").getByRole("button", { name: "Infisical" }).click();
  await expect(dialog.getByLabel("Infisical Client Secret")).toHaveValue("");
  await expect(dialog.getByLabel("Infisical Client Secret")).toHaveAttribute("placeholder", "已保存，留空保持不变");
  const result = await page.request.get("/api/telegram/settings");
  expect(await result.text()).not.toContain("fixture-secret");
});

test("failed automatic save is visible and can be retried", async ({ page }) => {
  await page.goto("/");
  await page.locator(".workspace-button").click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("navigation").getByRole("button", { name: "Codex 运行设置" }).click();
  const picker = dialog.getByRole("combobox", { name: "当前模型" });
  await expect(picker).toBeEnabled();
  await page.route("**/api/config", route => route.request().method() === "PUT" ? route.fulfill({ status: 500, json: { error: "保存失败，请重试" } }) : route.continue());
  await picker.selectOption("fixture-secondary");
  await expect(dialog.getByRole("alert")).toContainText("保存失败，请重试");
  await page.unroute("**/api/config");
  await dialog.getByRole("button", { name: "重试自动保存" }).click();
  await expect(dialog.getByText("Codex 设置已自动保存")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.locator(".workspace-button").click();
  await dialog.getByRole("navigation").getByRole("button", { name: "Codex 运行设置" }).click();
  await expect(picker).toHaveValue("fixture-secondary");
  await picker.selectOption("");
  await dialog.getByRole("button", { name: "关闭设置" }).click();
});
