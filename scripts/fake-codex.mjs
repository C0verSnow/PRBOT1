#!/usr/bin/env node
// Remote CI fixture. Runs through the real SDK's CLI subprocess transport; never enabled by default.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("app-server")) {
  let initialized = false;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fixture" } }) + "\n");
    if (request.method === "initialized") initialized = true;
    if (request.method === "model/list") {
      if (!initialized) throw new Error("Missing initialize handshake");
      if (process.env.PRBOT_TEST_MODELS_FAILURE) process.stdout.write(JSON.stringify({ id: request.id, error: { code: -1, message: "fixture failure" } }) + "\n");
      else process.stdout.write(JSON.stringify({ id: request.id, result: { data: request.params.cursor ? [{ model: "fixture-secondary", displayName: "CI 第二模型", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }], defaultReasoningEffort: "low", serviceTiers: [{ id: "priority", name: "Fast", description: "" }] }] : [{ model: "fixture-default", displayName: "CI 默认模型", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }], defaultReasoningEffort: "medium", serviceTiers: [] }, { model: "fixture-hidden", hidden: true }], nextCursor: request.params.cursor ? null : "page-2" } }) + "\n");
    }
  }
  process.exit(0);
}
const readOnly = args.includes("read-only");
if ((!args.includes("danger-full-access") && !readOnly) || !args.includes('approval_policy="never"')) throw new Error("Expected access options missing");
if (!args.includes("--skip-git-repo-check")) {
  process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified"); process.exit(1);
}
if (args.includes("workspace-write") || args.includes("sandbox_workspace_write.network_access=false")) throw new Error("Unexpected restricted Telegram policy");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === "模拟启动退出" || prompt.includes("用户消息：\n模拟启动退出\n")) {
  process.stderr.write("Reading prompt from stdin... Not inside a trusted directory and --skip-git-repo-check was not specified"); process.exit(1);
}
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
const resumed = args.includes("resume");
const id = resumed ? args[args.indexOf("resume") + 1] : randomUUID();
emit({ type: "thread.started", thread_id: id });
emit({ type: "turn.started" });
if (prompt.includes("PRBOT_GITHUB_PLUGIN_")) {
  const created = prompt.includes("PRBOT_GITHUB_PLUGIN_PR_CREATE");
  const inspected = prompt.includes("PRBOT_GITHUB_PLUGIN_INSPECT");
  const metadataLine = prompt.split("\n").find(line => inspected ? line.startsWith("只读检查：{") : line.startsWith("{"));
  const metadata = JSON.parse(inspected ? metadataLine.slice("只读检查：".length) : metadataLine);
  const repository = inspected ? `${metadata.owner}/${metadata.repo}` : metadata.repository;
  const call = (id, tool, parameters, result) => emit({ type: "item.completed", item: { id, type: "mcp_tool_call", server: "github", tool, arguments: parameters, status: "completed", result: { content: [], structured_content: result } } });
  let data;
  if (inspected) {
    const body = "Read through the configured GitHub plugin fixture; 写入测试文件";
    call("issue-plugin", "fetch_issue", { repository_full_name: repository, issue_number: metadata.issueNumber }, { issue: { url: metadata.issueUrl, issue_number: metadata.issueNumber, title: "Fixture Issue", body, state: "open" } });
    call("repo-plugin", "get_repo", { repository_full_name: repository }, { repository_full_name: repository, name: metadata.repo, owner: { login: metadata.owner }, default_branch: "main", permissions: { push: true, pull: true } });
    data = { title: "Fixture Issue", context: body, defaultBranch: "main", canRead: true, canWrite: true, isOpen: true, isPullRequest: false };
  } else {
    const prUrl = `https://github.com/${repository}/pull/15`;
    call("lookup-plugin", "search_prs", { repository_full_name: repository, query: `head:${metadata.head} base:${metadata.base}`, state: "open" }, { issues: [] });
    if (created) call("create-plugin", "create_pull_request", { repository_full_name: repository, head: metadata.head, base: metadata.base }, { url: prUrl, head: metadata.head, base: metadata.base, state: "open", head_repo_full_name: repository });
    data = { repository, head: metadata.head, base: metadata.base, found: created, prUrl: created ? prUrl : null };
  }
  emit({ type: "item.completed", item: { id: "result", type: "agent_message", text: JSON.stringify(data) } });
  emit({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 20 } });
  process.exit(0);
}

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
  writeFileSync(path.join(cwd, "sdk-evidence.txt"), `written through SDK subprocess\nmodel=${args.includes("--model") ? args[args.indexOf("--model") + 1] : "default"}\neffort=${args.find(a => a.startsWith("model_reasoning_effort=")) || "default"}\nspeed=${args.find(a => a.startsWith("service_tier=")) || "default"}\n`);
  emit({ type: "item.completed", item: { id: "file", type: "file_change", changes: [{ path: "sdk-evidence.txt", kind: "add" }], status: "completed" } });
}
emit({ type: "item.started", item: { id: "command", type: "command_execution", command: "pwd", aggregated_output: "", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "command", type: "command_execution", command: "pwd", aggregated_output: "CI fixture workspace", status: "completed", exit_code: 0 } });
emit({ type: "item.completed", item: { id: "msg", type: "agent_message", text: args.includes("--output-schema") ? JSON.stringify({ status: "completed", summary: resumed ? "远程原线程已继续" : "远程任务已处理", question: null }) : resumed ? "已接着上次对话继续。\n\n```ts\nconst continued = true;\n```" : "你好！我已连接到当前项目。\n\n- 可以阅读代码\n- 可以修改文件" } });
emit({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 10 } });
