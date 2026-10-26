#!/usr/bin/env node
// Remote CI fixture. Runs through the real SDK's CLI subprocess transport; never enabled by default.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (!args.includes("danger-full-access") || !args.includes('approval_policy="never"')) throw new Error("Full access options missing");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
const resumed = args.includes("resume");
const id = resumed ? args[args.indexOf("resume") + 1] : randomUUID();
emit({ type: "thread.started", thread_id: id });
emit({ type: "turn.started" });
if (prompt.includes("模拟失败")) { emit({ type: "turn.failed", error: { message: "测试服务暂时不可用" } }); process.exit(0); }
if (prompt.includes("滚动验证")) {
  const text = Array.from({ length: 60 }, (_, index) => `阅读段落 ${index + 1}：流式更新时保留当前阅读位置。`).join("\n\n");
  emit({ type: "item.updated", item: { id: "scroll", type: "agent_message", text } });
  await new Promise(resolve => setTimeout(resolve, 1800));
  emit({ type: "item.updated", item: { id: "scroll", type: "agent_message", text: `${text}\n\n更新已到达` } });
  await new Promise(resolve => setTimeout(resolve, 800));
  emit({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 50 } });
  process.exit(0);
}
if (prompt.includes("长任务")) {
  emit({ type: "item.updated", item: { id: "msg", type: "agent_message", text: "正在执行长任务" } });
  await new Promise(resolve => setTimeout(resolve, 60_000));
}
if (prompt.includes("写入测试文件")) {
  const cwd = args[args.indexOf("--cd") + 1];
  writeFileSync(path.join(cwd, "sdk-evidence.txt"), "written through SDK subprocess\n");
  emit({ type: "item.completed", item: { id: "file", type: "file_change", changes: [{ path: "sdk-evidence.txt", kind: "add" }], status: "completed" } });
}
emit({ type: "item.started", item: { id: "command", type: "command_execution", command: "pwd", aggregated_output: "", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "command", type: "command_execution", command: "pwd", aggregated_output: "CI fixture workspace", status: "completed", exit_code: 0 } });
emit({ type: "item.completed", item: { id: "msg", type: "agent_message", text: resumed ? "已接着上次对话继续。\n\n```ts\nconst continued = true;\n```" : "你好！我已连接到当前项目。\n\n- 可以阅读代码\n- 可以修改文件" } });
emit({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 10 } });
