import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), run: vi.fn() }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.open }));
import { pluginEnsurePullRequest, pluginInspectIssue } from "../src/lib/telegram-github-plugin";
const issue = { owner: "Owner", repo: "repo", number: 14, url: "https://github.com/Owner/repo/issues/14", title: "Telegram support" };
const details = () => ({ title: issue.title, context: "Issue body\n\nreviewer: keep the issue open", defaultBranch: "main", canRead: true, canWrite: true, isOpen: true, isPullRequest: false });
const pr = (found = true) => ({ repository: "Owner/repo", head: "feature/issue-14", base: "main", found, prUrl: found ? "https://github.com/Owner/repo/pull/15" : null });
type Call = { tool: string; args: object; result: unknown; status?: string };
const issueCall = (body = "Issue body"): Call => ({ tool: "github_fetch_issue", args: { repository_full_name: "Owner/repo", issue_number: 14 }, result: { structuredContent: { issue: { url: issue.url, issue_number: 14, title: issue.title, body, state: "open" } } } });
const repoCall = (push = true): Call => ({ tool: "github_get_repo", args: { repository_full_name: "Owner/repo" }, result: { structuredContent: { repository_full_name: "Owner/repo", name: "repo", owner: { login: "Owner" }, default_branch: "main", permissions: { push } } } });
const commentCall = (): Call => ({ tool: "github_fetch_issue_comments", args: { repo_full_name: "Owner/repo", issue_number: 14 }, result: { structuredContent: { comments: [{ url: `${issue.url}#comment-1`, user: { login: "reviewer" }, body: "keep the issue open" }] } } });
const searchCall = (found = true): Call => ({ tool: "github_search_prs", args: { repository_full_name: "Owner/repo", query: "head:feature/issue-14 base:main", state: "open" }, result: { structuredContent: { issues: found ? [{ url: "https://github.com/Owner/repo/pull/15", state: null }] : [] } } });
function fixture(value: unknown, options: { tool?: false; calls?: Call[]; complete?: boolean; sideEffect?: boolean; raw?: boolean } = {}) {
  const isPR = !!value && typeof value === "object" && "found" in value;
  const calls = options.calls || (isPR ? [searchCall((value as { found: boolean }).found)] : [issueCall(), repoCall(), commentCall()]);
  mocks.run.mockImplementation(async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "github-plugin-thread" };
    if (options.tool !== false) for (const [index, call] of calls.entries()) yield { type: "item.completed", item: { id: `github-call-${index}`, type: "mcp_tool_call", server: "codex_apps", tool: call.tool, arguments: call.args, result: call.result, status: call.status || "completed" } };
    if (options.sideEffect) yield { type: "item.started", item: { id: "forbidden", type: "command_execution", command: "gh issue view 14", status: "in_progress", aggregated_output: "" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: options.raw ? String(value) : JSON.stringify(value) } };
    if (options.complete !== false) yield { type: "turn.completed" };
  })() }));
}
beforeEach(() => { mocks.open.mockReset(); mocks.run.mockReset(); mocks.open.mockImplementation(async () => ({ runStreamed: mocks.run })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Codex's configured GitHub plugin bridge", () => {
  it("derives Issue, comments, default branch and permissions from bound actual plugin responses", async () => {
    fixture(details()); expect(await pluginInspectIssue("/project", issue)).toEqual(details());
    expect(mocks.open).toHaveBeenCalledWith(undefined, { workspace: "/project", readOnly: true });
    const [prompt, options] = mocks.run.mock.calls[0];
    expect(prompt).toContain("PRBOT_GITHUB_PLUGIN_INSPECT"); expect(prompt).toContain("不要索要 GITHUB_TOKEN");
    expect(prompt).toContain("permissions.push"); expect(options.outputSchema.additionalProperties).toBe(false);
  });
  it("bounds actual external text and refuses a model's unsupported permission upgrade", async () => {
    const actual = issueCall("x".repeat(70_000));
    fixture({ ...details(), canWrite: true }, { calls: [actual, repoCall(false)] });
    const result = await pluginInspectIssue("/project", issue);
    expect(result.context).toHaveLength(60_000); expect(result.canWrite).toBe(false);
  });
  it("supports normalized text JSON and snake-case structured wrappers", async () => {
    const actual = issueCall(); actual.result = { content: [{ type: "text", text: JSON.stringify({ issue: { url: issue.url, title: issue.title, body: "text result", state: "open", number: 14 } }) }] };
    const repo = repoCall(); repo.result = { structured_content: { repository: { full_name: "Owner/repo", default_branch: "main", permissions: { maintain: true } } } };
    fixture(details(), { calls: [actual, repo] });
    expect(await pluginInspectIssue("/project", issue)).toMatchObject({ context: "text result", canWrite: true });
  });
  it("rejects unrelated profile or repository calls despite plausible model JSON", async () => {
    fixture(details(), { calls: [{ tool: "github_get_profile", args: {}, result: { structuredContent: { login: "Owner" } } }] });
    await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("实际读取证据");
    const other = repoCall(); other.args = { repository_full_name: "Other/repo" };
    fixture(details(), { calls: [issueCall(), other] }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("实际读取证据");
    const wrong = issueCall(); wrong.result = { structuredContent: { issue: { url: "https://github.com/Other/repo/issues/14", title: "Other", body: "Other", state: "open" } } };
    fixture(details(), { calls: [wrong, repoCall()] }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("实际读取证据");
  });
  it("does not use another user's collaborator permission as the logged-in identity's permission", async () => {
    fixture(details(), { calls: [issueCall(), repoCall(false), { tool: "github_get_repo_collaborator_permission", args: { repository_full_name: "Owner/repo", username: "some-admin" }, result: { structuredContent: { permission: "admin" } } }] });
    expect((await pluginInspectIssue("/project", issue)).canWrite).toBe(false);
  });
  it("requires successful MCP evidence, a completed turn and strict typed final JSON", async () => {
    fixture(details(), { tool: false }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("成功 GitHub 插件调用");
    fixture(details(), { calls: [{ ...issueCall(), status: "failed" }] }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("成功 GitHub 插件调用");
    fixture(details(), { complete: false }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("提前结束");
    fixture("not json", { raw: true }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("JSON");
    fixture({ ...details(), canWrite: "true" }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("格式不正确");
  });
  it("rejects shell fallback and forwards cancellation before invoking the SDK", async () => {
    fixture(details(), { sideEffect: true }); await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("后备操作");
    const controller = new AbortController(); controller.abort(new Error("cancelled")); mocks.open.mockClear();
    await expect(pluginInspectIssue("/project", issue, controller.signal)).rejects.toThrow("cancelled"); expect(mocks.open).not.toHaveBeenCalled();
  });
  it("proves an absent PR only with an empty actual query bound to repo, head, base and open state", async () => {
    fixture(pr(false)); expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).toBeUndefined();
    const broad = searchCall(false); broad.args = { repository_full_name: "Owner/repo", query: "head:other", state: "open" };
    fixture(pr(false), { calls: [broad] }); await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("证据");
  });
  it("accepts bound search results and normalized get_pr or create results", async () => {
    fixture(pr()); expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).toBe(pr().prUrl);
    const detail: Call = { tool: "github_get_pr", args: { repository_full_name: "Owner/repo", pr_number: 15 }, result: { structuredContent: { url: pr().prUrl, head: "feature/issue-14", base: "main", state: "open", head_repo_full_name: "Owner/repo" } } };
    fixture(pr(), { calls: [detail] }); expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).toBe(pr().prUrl);
    fixture(pr(), { calls: [searchCall(false), { ...detail, tool: "github_create_pull_request", args: { repository_full_name: "Owner/repo", head: "feature/issue-14", base: "main" } }] });
    expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", true)).toBe(pr().prUrl);
    expect(mocks.run.mock.calls.at(-1)?.[0]).toContain("先通过 GitHub 插件查找");
  });
  it("rejects invented URLs and actual results from unrelated repos or branches", async () => {
    fixture({ ...pr(), prUrl: "https://github.com/Owner/repo/pull/99" });
    await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("证据");
    const wrongRepo = searchCall(); wrongRepo.args = { repository_full_name: "Other/repo", query: "head:feature/issue-14 base:main", state: "open" };
    fixture(pr(), { calls: [wrongRepo] }); await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("证据");
    const wrongHead = searchCall(); wrongHead.result = { structuredContent: { url: pr().prUrl, head: "other", base: "main", state: "open" } };
    fixture(pr(), { calls: [wrongHead] }); await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("证据");
  });
});
