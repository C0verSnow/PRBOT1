import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
async function sidebar(page: import("@playwright/test").Page) {
  const open = page.getByRole("button", { name: "打开侧栏" });
  if (await open.isVisible()) await open.click();
}
async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}
test("chat, real SDK transport, file operation, resume, error, stop and history", async ({ page }, info) => {
  const browserErrors: string[] = []; page.on("pageerror", e => browserErrors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "了解这个项目" })).toBeEnabled();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("想法");
  await page.screenshot({ path: info.outputPath("welcome.png"), fullPage: true });
  await page.getByRole("button", { name: "完全访问" }).click();
  await expect(page.getByRole("dialog")).toContainText("无执行隔离");
  await page.getByRole("button", { name: "关闭设置" }).click();
  const first = `写入测试文件 ${info.project.name}`;
  await send(page, first);
  await expect(page.getByText("你好！我已连接到当前项目。")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  expect(await readFile(".data/workspace/sdk-evidence.txt", "utf8")).toContain("written through SDK");
  await page.getByText(/执行过程/).click();
  await expect(page.getByText("修改文件", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("conversation.png"), fullPage: true });
  await page.reload();
  await sidebar(page);
  await page.getByRole("button", { name: first, exact: true }).click();
  await send(page, "继续");
  await expect(page.getByText("已接着上次对话继续。")).toBeVisible();
  await expect(page.locator(".markdown pre")).toContainText("const continued = true;");
  await send(page, "模拟失败");
  await expect(page.getByText(/测试服务暂时不可用/)).toBeVisible();
  await send(page, "长任务");
  await expect(page.getByText("正在执行长任务")).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText(/执行已停止/)).toBeVisible();
  await send(page, "停止后继续");
  await expect(page.getByText("已接着上次对话继续。")).toHaveCount(2);
  await sidebar(page);
  await page.getByRole("button", { name: "新对话", exact: false }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(browserErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("API rejects cross-site requests and malformed input", async ({ request }) => {
  expect((await request.post("/api/chats", { headers: { origin: "https://evil.example" } })).status()).toBe(403);
  const created = await request.post("/api/chats"); const { id } = await created.json();
  expect((await request.post(`/api/chats/${id}/turn`, { data: { prompt: " " } })).status()).toBe(400);
  expect((await request.post(`/api/chats/${id}/turn`, { data: { prompt: "a".repeat(16001) } })).status()).toBe(400);
  expect((await request.delete(`/api/chats/${id}`)).status()).toBe(204);
});
