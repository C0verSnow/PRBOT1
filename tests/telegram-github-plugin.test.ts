import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), run: vi.fn() }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.open }));
import { pluginEnsurePullRequest, pluginInspectIssue } from "../src/lib/telegram-github-plugin";
const issue = { owner: "Owner", repo: "repo", number: 14, url: "https://github.com/Owner/repo/issues/14", title: "Telegram support" };
const details = () => ({ title: issue.title, context: "Issue body\nComment: keep the issue open", defaultBranch: "main", canRead: true, canWrite: true, isOpen: true, isPullRequest: false });
const pr = (found = true) => ({ repository: "Owner/repo", head: "feature/issue-14", base: "main", found, prUrl: found ? "https://github.com/Owner/repo/pull/15" : null });
function fixture(value: unknown, options: { tool?: string | false; status?: string; complete?: boolean; sideEffect?: boolean; raw?: boolean } = {}) {
  mocks.run.mockImplementation(async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "github-plugin-thread" };
    if (options.tool !== false) yield { type: "item.completed", item: { id: "github-call", type: "mcp_tool_call", server: "codex_apps", tool: options.tool || "github_fetch_issue", status: options.status || "completed" } };
    if (options.sideEffect) yield { type: "item.started", item: { id: "forbidden", type: "command_execution", command: "gh issue view 14", status: "in_progress", aggregated_output: "" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: options.raw ? String(value) : JSON.stringify(value) } };
    if (options.complete !== false) yield { type: "turn.completed" };
  })() }));
}
beforeEach(() => { mocks.open.mockReset(); mocks.run.mockReset(); mocks.open.mockImplementation(async () => ({ runStreamed: mocks.run })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Codex's configured GitHub plugin bridge", () => {
  it("reads the Issue and permissions through a read-only SDK thread without a token fallback", async () => {
    fixture(details());
    expect(await pluginInspectIssue("/project", issue)).toEqual(details());
    expect(mocks.open).toHaveBeenCalledWith(undefined, { workspace: "/project", readOnly: true });
    const [prompt, options] = mocks.run.mock.calls[0];
    expect(prompt).toContain("PRBOT_GITHUB_PLUGIN_INSPECT"); expect(prompt).toContain("不要索要 GITHUB_TOKEN");
    expect(prompt).toContain("permissions.push"); expect(prompt).toContain(issue.url);
    expect(options.outputSchema.additionalProperties).toBe(false); expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("bounds external text and never upgrades false permission evidence", async () => {
    fixture({ ...details(), context: "x".repeat(70_000), title: "x".repeat(250), canWrite: false });
    const result = await pluginInspectIssue("/project", issue);
    expect(result.context).toHaveLength(60_000); expect(result.title).toHaveLength(200); expect(result.canWrite).toBe(false);
  });
  it("rejects hallucinated success without a successful completed GitHub MCP call", async () => {
    for (const options of [{ tool: false as const }, { tool: "other_fetch_issue" }, { status: "failed" }]) {
      fixture(details(), options);
      await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("没有收到成功的 GitHub 插件调用");
    }
  });
  it("requires a completed turn, strict JSON fields and typed permission flags", async () => {
    fixture(details(), { complete: false }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("提前结束");
    fixture("not json", { raw: true }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("JSON");
    fixture({ ...details(), canWrite: "true" }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("格式不正确");
    fixture({ ...details(), extra: "unexpected" }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("格式不正确");
  });
  it("rejects shell fallback events and forwards cancellation before invoking the SDK", async () => {
    fixture(details(), { sideEffect: true }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("后备操作");
    const controller = new AbortController(); controller.abort(new Error("cancelled")); mocks.open.mockClear();
    await expect(pluginInspectIssue("/project", issue, controller.signal)).rejects.toThrow("cancelled");
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("only looks up a PR before publication confirmation", async () => {
    fixture(pr(false), { tool: "github_search_prs" });
    expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).toBeUndefined();
    expect(mocks.run.mock.calls[0][0]).toContain("PRBOT_GITHUB_PLUGIN_PR_LOOKUP");
    expect(mocks.run.mock.calls[0][0]).toContain("不得创建任何 PR");
  });
  it("requires a real matching PR URL and rechecks before creating after confirmation", async () => {
    fixture(pr(), { tool: "github_create_pull_request" });
    expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", true)).toBe("https://github.com/Owner/repo/pull/15");
    const prompt = mocks.run.mock.calls[0][0]; expect(prompt).toContain("PRBOT_GITHUB_PLUGIN_PR_CREATE");
    expect(prompt).toContain("先通过 GitHub 插件查找"); expect(prompt).toContain("不要使用 closes/fixes/resolves");
    fixture(pr(false)); await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", true)).rejects.toThrow("未确认 PR 已创建");
  });
  it("rejects cross-repository URLs, misleading links and mismatched branch results", async () => {
    for (const url of ["https://github.com/Other/repo/pull/15", "https://github.com/Owner/repo/issues/15", "http://github.com/Owner/repo/pull/15", "https://token@github.com/Owner/repo/pull/15", "https://github.com/Owner/repo/pull/15?token=private", "https://github.com:443/Owner/repo/pull/15", "https://github.com/Owner/repo/pull/9007199254740992"]) {
      fixture({ ...pr(), prUrl: url });
      await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("链接");
    }
    fixture({ ...pr(), head: "other-branch" }); await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("不匹配");
  });
});
