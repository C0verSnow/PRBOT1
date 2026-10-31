import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), run: vi.fn() }));
vi.mock("../src/lib/codex", () => ({ openThread: mocks.open }));
import { pluginEnsurePullRequest, pluginInspectIssue, issueClosePolicy, pluginInspectDelivery, pluginCloseIssue } from "../src/lib/telegram-github-plugin";
const issue = { owner: "Owner", repo: "repo", number: 14, url: "https://github.com/Owner/repo/issues/14", title: "Telegram support" };
const details = () => ({ title: issue.title, context: "Issue body\n\nreviewer: keep the issue open", defaultBranch: "main", canRead: true, canWrite: true, isOpen: true, isPullRequest: false });
const pr = (found = true) => ({ repository: "Owner/repo", head: "feature/issue-14", base: "main", found, prUrl: found ? "https://github.com/Owner/repo/pull/15" : null });
type Call = { tool: string; args: object; result: unknown; status?: string; error?: { message: string } };
const issueCall = (body = "Issue body"): Call => ({ tool: "github_fetch_issue", args: { repository_full_name: "Owner/repo", issue_number: 14 }, result: { structuredContent: { issue: { url: issue.url, issue_number: 14, title: issue.title, body, state: "open" } } } });
const repoCall = (push = true): Call => ({ tool: "github_get_repo", args: { repository_full_name: "Owner/repo" }, result: { structuredContent: { repository_full_name: "Owner/repo", name: "repo", owner: { login: "Owner" }, default_branch: "main", permissions: { push } } } });
const commentCall = (): Call => ({ tool: "github_fetch_issue_comments", args: { repo_full_name: "Owner/repo", issue_number: 14 }, result: { structuredContent: { comments: [{ url: `${issue.url}#comment-1`, user: { login: "reviewer" }, body: "keep the issue open" }] } } });
const searchCall = (found = true): Call => ({ tool: "github_search_prs", args: { repository_full_name: "Owner/repo", query: "head:feature/issue-14 base:main", state: "open" }, result: { structuredContent: { issues: found ? [{ url: "https://github.com/Owner/repo/pull/15", state: null }] : [] } } });
function fixture(value: unknown, options: { tool?: false; calls?: Call[]; complete?: boolean; sideEffect?: boolean; raw?: boolean } = {}) {
  const isPR = !!value && typeof value === "object" && "found" in value;
  const calls = options.calls || (isPR ? [searchCall((value as { found: boolean }).found)] : [issueCall(), repoCall(), commentCall()]);
  mocks.run.mockImplementation(async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "github-plugin-thread" };
    if (options.tool !== false) for (const [index, call] of calls.entries()) yield { type: "item.completed", item: { id: `github-call-${index}`, type: "mcp_tool_call", server: "codex_apps", tool: call.tool, arguments: call.args, result: call.result, status: call.status || "completed", error: call.error } };
    if (options.sideEffect) yield { type: "item.started", item: { id: "forbidden", type: "command_execution", command: "gh issue view 14", status: "in_progress", aggregated_output: "" } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: options.raw ? String(value) : JSON.stringify(value) } };
    if (options.complete !== false) yield { type: "turn.completed" };
  })() }));
}
beforeEach(() => { mocks.open.mockReset(); mocks.run.mockReset(); mocks.open.mockImplementation(async () => ({ runStreamed: mocks.run })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Codex's configured GitHub plugin bridge", () => {
  it("derives Issue, comments, default branch and permissions from bound actual plugin responses", async () => {
    fixture(details()); expect(await pluginInspectIssue("/project", issue)).toMatchObject({ ...details(), closePolicy: "keep_open" });
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

const sha = "a".repeat(40);
const deliveryIssue = { ...issue, baseBranch: "main" };
const branch = "feature/issue-14";
const prUrl = "https://github.com/Owner/repo/pull/15";
function apiCall(tail: string, payload: unknown): Call {
  return { tool: "github_fetch", args: { url: `https://api.github.com/repos/Owner/repo${tail}` }, result: { structuredContent: { content: JSON.stringify(payload) } } };
}
function deliveryCalls(options: { conclusion?: string; status?: string; empty?: boolean; wrongSha?: boolean; truncated?: boolean; body?: string; issueState?: string } = {}): Call[] {
  const check = { id: 101, name: "verify", head_sha: options.wrongSha ? "b".repeat(40) : sha, status: options.status || "completed", conclusion: options.conclusion || "success", app: { id: 1 }, html_url: "https://github.com/Owner/repo/actions/runs/1" };
  return [
    apiCall("/pulls/15", { html_url: prUrl, state: "open", merged: false, head: { ref: branch, sha, repo: { full_name: "Owner/repo" } }, base: { ref: "main" } }),
    apiCall("/issues/14", { html_url: issue.url, number: 14, state: options.issueState || "open", body: options.body || "完成后提 PR 并关闭 issue" }),
    apiCall(`/commits/${sha}/check-runs?filter=latest&per_page=100`, { total_count: options.truncated ? 2 : options.empty ? 0 : 1, check_runs: options.empty ? [] : [check] }),
    apiCall(`/commits/${sha}/status?per_page=100`, { sha, total_count: 0, statuses: [] }),
    apiCall(`/actions/runs?head_sha=${sha}&per_page=100`, { total_count: 0, workflow_runs: [] }),
  ];
}
describe("delivery evidence and explicit Issue closure", () => {
  it("derives closure only from explicit actual body wording, with keep-open taking priority", async () => {
    expect(issueClosePolicy("完成后 提 PR (等我review)并关闭 issue / 跑通测试 / 更新文档")).toBe("after_ci");
    expect(issueClosePolicy("Please close this issue after CI passes")).toBe("after_ci");
    for (const body of ["创建 PR", "不要关闭 Issue", "并关闭 Issue，但不要自动关闭", "Keep this issue open; then close the issue", "> 完成后关闭 issue\n仅为示例", "```\n并关闭 issue\n```", "Do not close the issue"]) expect(issueClosePolicy(body)).toBe("keep_open");
    fixture({ ...details(), closePolicy: "after_ci" }, { calls: [issueCall("创建 PR"), repoCall()] });
    // Model closure fields are not part of the inspection schema and cannot grant authority.
    await expect(pluginInspectIssue("/project", issue)).rejects.toThrow("格式不正确");
    fixture(details(), { calls: [issueCall("完成后并关闭 issue"), repoCall(), commentCall()] });
    expect((await pluginInspectIssue("/project", issue)).closePolicy).toBe("after_ci");
  });
  it("uses current PR/head and all three CI sources rather than model claims", async () => {
    fixture({ ok: false }, { calls: deliveryCalls() });
    expect(await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).toMatchObject({ state: "passed", sha, issueState: "open", closePolicy: "after_ci" });
    fixture({ ok: true }, { calls: deliveryCalls({ conclusion: "failure" }) });
    expect((await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).state).toBe("failed");
    fixture({ ok: true }, { calls: deliveryCalls({ status: "in_progress" }) });
    expect((await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).state).toBe("pending");
    fixture({ ok: true }, { calls: deliveryCalls({ empty: true }) });
    expect((await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).state).toBe("missing");
  });
  it("refuses stale commits, missing sources, truncated lists and changed PR heads", async () => {
    fixture({ ok: true }, { calls: deliveryCalls({ wrongSha: true }) });
    await expect(pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).rejects.toThrow("当前提交");
    fixture({ ok: true }, { calls: deliveryCalls({ truncated: true }) });
    await expect(pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).rejects.toThrow("分页不完整");
    fixture({ ok: true }, { calls: deliveryCalls().slice(0, -1) });
    await expect(pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).rejects.toThrow("读取证据");
    const changed = deliveryCalls(); changed[0] = apiCall("/pulls/15", { html_url: prUrl, state: "open", head: { ref: branch, sha: "b".repeat(40), repo: { full_name: "Owner/repo" } }, base: { ref: "main" } });
    fixture({ ok: true }, { calls: changed }); await expect(pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).rejects.toThrow("当前提交");
  });
  it("waits for workflow-level failures even when individual checks already passed", async () => {
    const calls = deliveryCalls();
    calls[4] = apiCall(`/actions/runs?head_sha=${sha}&per_page=100`, { total_count: 1, workflow_runs: [{ id: 2, workflow_id: 1, name: "delivery", head_sha: sha, head_branch: branch, status: "completed", conclusion: "failure" }] });
    fixture({ ok: true }, { calls }); expect((await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).state).toBe("failed");
  });
  it("checks the latest retry without hiding unrelated failing checks", async () => {
    const calls = deliveryCalls();
    calls[2] = apiCall(`/commits/${sha}/check-runs?filter=latest&per_page=100`, { total_count: 2, check_runs: [
      { id: 1, name: "verify", head_sha: sha, status: "completed", conclusion: "failure", app: { id: 1 } },
      { id: 2, name: "verify", head_sha: sha, status: "completed", conclusion: "success", app: { id: 1 } },
    ] });
    fixture({ ok: true }, { calls }); expect((await pluginInspectDelivery("/project", deliveryIssue, prUrl, branch, sha)).state).toBe("passed");
  });
  it("never closes without passing CI and explicit policy; requires a read after mutation", async () => {
    const evidence = { sha, issueState: "open" as const, closePolicy: "after_ci" as const, state: "passed" as const, summary: "verify: success", urls: [] };
    await expect(pluginCloseIssue("/project", issue, { ...evidence, state: "failed" })).rejects.toThrow("不能关闭");
    await expect(pluginCloseIssue("/project", issue, { ...evidence, closePolicy: "keep_open" })).rejects.toThrow("不能关闭");
    const read = issueCall("并关闭 issue");
    const update: Call = { tool: "github_update_issue", args: { repository_full_name: "Owner/repo", issue_number: 14, state: "closed" }, result: { structuredContent: { issue: { url: issue.url, number: 14, state: "closed", body: "并关闭 issue" } } } };
    fixture({ ok: true }, { calls: [read, update] });
    await expect(pluginCloseIssue("/project", issue, evidence)).rejects.toThrow("尚未读回");
    const closed: Call = { ...read, result: update.result };
    fixture({ ok: true }, { calls: [closed] }); expect(await pluginCloseIssue("/project", issue, evidence)).toBe("closed");
    fixture({ ok: true }, { calls: [read, update, closed] }); expect(await pluginCloseIssue("/project", issue, evidence)).toBe("closed");
    fixture({ ok: true }, { calls: [issueCall("不要关闭 issue"), update, closed] }); await expect(pluginCloseIssue("/project", issue, evidence)).rejects.toThrow("要求已变化");
  });
});

describe("real connector query and approval compatibility", () => {
  it("accepts a PR-qualified issue search and multiple is qualifiers in either order", async () => {
    for (const query of ["repo:Owner/repo is:pr is:open head:feature/issue-14 base:main", "is:open is:pr repo:Owner/repo head:feature/issue-14 base:main"]) {
      const call: Call = { ...searchCall(false), tool: "github.search_issues", args: { query } };
      fixture(pr(false), { calls: [call] });
      expect(await pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).toBeUndefined();
    }
  });
  it("rejects issue-only searches, missing PR qualification and closed filters", async () => {
    for (const qualifier of ["is:issue is:open", "is:open", "is:pr is:open is:closed"]) {
      const call: Call = { ...searchCall(false), tool: "github.search_issues", args: { query: `repo:Owner/repo ${qualifier} head:feature/issue-14 base:main` } };
      fixture(pr(false), { calls: [call] });
      await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", false)).rejects.toThrow("证据");
    }
  });
  it("reports an explicit approval rejection after draining the completed stream", async () => {
    fixture(pr(false), { calls: [searchCall(false), { tool: "github.create_pull_request", args: { repository_full_name: "Owner/repo", head: "feature/issue-14", base: "main" }, result: {}, status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } }] });
    await expect(pluginEnsurePullRequest("/project", issue, "feature/issue-14", "main", true)).rejects.toThrow("写操作已被拒绝");
  });
});
