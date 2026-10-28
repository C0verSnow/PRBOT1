import { Codex, type ThreadEvent, type ThreadOptions, type ModelReasoningEffort } from "@openai/codex-sdk";
import { runtimeConfig } from "./config";
import type { Activity } from "./types";

export async function openThread(threadId?: string, remote?: { workspace: string }) {
  const config = await runtimeConfig(remote ? { workspace: remote.workspace } : {});
  const client = new Codex({
    apiKey: config.env.CODEX_API_KEY || config.env.OPENAI_API_KEY || undefined,
    codexPathOverride: config.codexPath || undefined,
    env: config.env,
    config: { ...(config.speed ? { service_tier: config.speed } : {}), ...(remote ? { mcp_servers: {}, sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } : {}) },
  });
  // Desktop retains the requested full access. Remote Telegram turns are workspace-bound;
  // Git publication is a separate backend action after explicit user confirmation.
  const options: ThreadOptions = {
    workingDirectory: config.workspace,
    model: config.model || undefined,
    modelReasoningEffort: (config.effort || undefined) as ModelReasoningEffort | undefined,
    sandboxMode: remote ? "workspace-write" : "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: !remote,
  };
  return threadId ? client.resumeThread(threadId, options) : client.startThread(options);
}
export function activity(event: ThreadEvent): Activity | undefined {
  if (!("item" in event)) return;
  const item = event.item;
  const base = { id: item.id, kind: item.type };
  switch (item.type) {
    case "agent_message": return;
    case "command_execution": return { ...base, title: item.command, detail: item.aggregated_output.slice(-12_000), status: item.status };
    case "file_change": return { ...base, title: "修改文件", detail: item.changes.map(c => `${c.kind}  ${c.path}`).join("\n"), status: item.status };
    case "mcp_tool_call": return { ...base, title: `${item.server} / ${item.tool}`, status: item.status, detail: item.error?.message };
    case "web_search": return { ...base, title: "搜索网页", detail: item.query };
    case "todo_list": return { ...base, title: "任务计划", detail: item.items.map(i => `${i.completed ? "✓" : "○"} ${i.text}`).join("\n") };
    case "reasoning": return { ...base, title: "思考摘要", detail: item.text };
    case "error": return { ...base, title: "执行提示", detail: item.message, status: "failed" };
  }
}
export function readableError(error: unknown, secrets: string[] = []) {
  let text = error instanceof Error ? error.message : "Codex 运行失败";
  for (const key of [process.env.CODEX_API_KEY, process.env.OPENAI_API_KEY, ...secrets]) {
    if (key) text = text.split(key).join("[已隐藏密钥]");
  }
  text = text.replace(/sk-[a-zA-Z0-9_-]+/g, "[已隐藏密钥]");
  return `${text.slice(0, 1200)}\n请检查本机 Codex 登录、模型权限和网络后重试。`;
}
