import { test, expect } from "@playwright/test";
async function ready(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "发送给 Codex 的消息" })).toBeEnabled();
}
async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByRole("textbox", { name: "发送给 Codex 的消息" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}
async function openSidebar(page: import("@playwright/test").Page) {
  const open = page.getByRole("button", { name: "打开侧栏" });
  if (await open.isVisible()) await open.click();
}
test("quick switcher uses keyboard, restores focus and finds history", async ({ page }, info) => {
  await ready(page);
  const prompt = `快捷面板 ${info.project.name}`;
  await send(page, prompt);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "快速切换", exact: true }).last();
  await trigger.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "快速切换" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "搜索历史或操作" });
  await expect(search).toBeFocused();
  await search.fill("不存在的对话");
  await expect(dialog.getByText("没有找到相关对话，换个关键词试试。")).toBeVisible();
  await search.fill(prompt);
  await expect(dialog.getByRole("button", { name: prompt })).toBeVisible();
  await page.screenshot({ path: info.outputPath("quick-switcher.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+Shift+o");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox").fill(prompt);
  await page.getByRole("dialog").getByRole("button", { name: prompt }).click();
  await expect(page.getByText(prompt, { exact: true }).last()).toBeVisible();
});
test("draft survives refresh, textarea grows and next draft survives active output", async ({ page }) => {
  await ready(page);
  const input = page.getByRole("textbox", { name: "发送给 Codex 的消息" });
  const height = (await input.boundingBox())!.height;
  await input.fill("第一行\n第二行\n第三行\n第四行\n第五行");
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(height);
  await page.reload();
  await expect(input).toHaveValue("第一行\n第二行\n第三行\n第四行\n第五行");
  await send(page, "长任务");
  await expect(page.getByText("正在执行长任务")).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill("下一条草稿，不要清除");
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  await expect(input).toHaveValue("下一条草稿，不要清除");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("已接着上次对话继续。")).toBeVisible();
  await expect(input).toHaveValue("");
});
test("native deletion dialog and sidebar collapse provide clear feedback", async ({ page }, info) => {
  await ready(page); const title = `删除交互 ${info.project.name}`;
  await send(page, title);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  if (info.project.name === "chromium") {
    await page.getByRole("button", { name: "收起侧栏" }).click();
    await expect(page.getByRole("navigation", { name: "对话历史" })).not.toBeVisible();
    await page.getByRole("button", { name: "展开侧栏" }).click();
    await expect(page.getByRole("navigation", { name: "对话历史" })).toBeVisible();
  }
  await openSidebar(page);
  await page.getByRole("button", { name: `删除 ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除这段对话？" });
  await expect(dialog).toContainText("已经修改的项目文件会保留");
  await dialog.getByRole("button", { name: "保留对话" }).click();
  await page.getByRole("button", { name: `删除 ${title}`, exact: true }).click();
  await dialog.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "对话记录已删除" })).toBeVisible();
  await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
});
test("system reduced-motion changes disable movement without hiding content", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await expect(page.locator(".interaction-root")).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".interaction-root")).toHaveAttribute("data-reduced-motion", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".interaction-root")).toHaveAttribute("data-reduced-motion", "true");
});
test("stream updates preserve reading position until explicitly following again", async ({ page }) => {
  await ready(page);
  await send(page, "滚动验证");
  await expect(page.getByText("阅读段落 60：流式更新时保留当前阅读位置。", { exact: true })).toBeAttached();
  const viewport = page.locator(".chat-scroll");
  await viewport.evaluate(element => { element.scrollTop = 120; });
  await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
  const before = await viewport.evaluate(element => element.scrollTop);
  await expect(page.getByText("更新已到达", { exact: true })).toBeAttached();
  expect(Math.abs(await viewport.evaluate(element => element.scrollTop) - before)).toBeLessThan(3);
  await page.getByRole("button", { name: "回到最新消息" }).click();
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(5);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
});
