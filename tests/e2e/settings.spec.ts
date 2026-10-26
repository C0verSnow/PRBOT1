import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
test("model discovery, persistence and actual SDK model argument agree", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "发送给 Codex 的消息" })).toBeEnabled();
  await page.locator(".workspace-button").click();
  const settings = page.getByRole("dialog", { name: "工作空间" });
  const picker = settings.getByRole("combobox", { name: "当前模型", exact: true });
  await expect(picker).toBeEnabled();
  await picker.selectOption("fixture-secondary");
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(settings).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".model-name")).toHaveText("fixture-secondary");
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill("写入测试文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("你好！我已连接到当前项目。")).toBeVisible();
  expect(await readFile(path.resolve(".data/workspace/sdk-evidence.txt"), "utf8")).toContain("model=fixture-secondary");
  await page.locator(".workspace-button").click();
  await expect(picker).toHaveValue("fixture-secondary");
  await page.screenshot({ path: info.outputPath("workspace-settings.png"), fullPage: true, animations: "disabled" });
  await picker.selectOption("");
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
});
test("settings cannot change while a task is running and failures remain actionable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill("长任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("正在执行长任务")).toBeVisible();
  await page.locator(".workspace-button").click();
  const dialog = page.getByRole("dialog", { name: "工作空间" });
  await expect(dialog.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  await page.route("**/api/models", route => route.fulfill({ status: 502, json: { error: "模型读取失败，请刷新重试" } }));
  await page.locator(".workspace-button").click();
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
