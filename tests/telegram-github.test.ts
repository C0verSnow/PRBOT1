import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, githubRemote, inspectIssue, parseIssueLink, prepareIssue, publishIssue, reviewSnapshot } from "../src/lib/telegram-github";
import type { TelegramIssue } from "../src/lib/telegram-task-store";

const exec = promisify(execFile);
const issueUrl = "https://github.com/Owner/project/issues/14";
const branch = "feature/issue-14-fixture";
let home: string;
let workspace: string;
let remote: string;
let calls: Array<{ url: URL; method: string; body?: Record<string, unknown>; authorization: string | null }>;
let issueData: { title: string; body: string; comments: number; state: string; pull_request?: object };
let repoData: { default_branch: string; permissions?: { push?: boolean } };
let existing: Array<{ html_url: string }>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "prbot-github-")));
  workspace = path.join(home, "project"); remote = path.join(home, "remote.git");
  await mkdir(workspace);
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "main", workspace]);
  await git(workspace, ["config", "user.name", "PRBOT fixture"]);
  await git(workspace, ["config", "user.email", "fixture@example.test"]);
  await git(workspace, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(workspace, "README.md"), "base\n");
  await writeFile(path.join(workspace, ".gitignore"), ".env\n");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "Fixture base"]);
  await git(workspace, ["push", remote, "main"]);
  await git(workspace, ["remote", "add", "origin", "git@github.com:Owner/project.git"]);
  await git(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(workspace, ["switch", "-c", branch]);

  // CI-only transport fixture: real Git upload/receive-pack against a local bare repo.
  // No GitHub network, token or external repository can be written by these tests.
  const ssh = path.join(home, "git-ssh.mjs");
  await writeFile(ssh, `import { spawnSync } from "node:child_process";\nconst request = process.argv.at(-1) || "";\nconst action = request.startsWith("git-upload-pack ") ? "git-upload-pack" : request.startsWith("git-receive-pack ") ? "git-receive-pack" : "";\nif (!action || !process.env.PRBOT_TEST_GIT_REMOTE_PATH) process.exit(2);\nprocess.exit(spawnSync(action, [process.env.PRBOT_TEST_GIT_REMOTE_PATH], { stdio: "inherit" }).status ?? 2);\n`);
  vi.stubEnv("GIT_SSH_COMMAND", `${quote(process.execPath)} ${quote(ssh)}`);
  vi.stubEnv("GIT_SSH_VARIANT", "simple");
  vi.stubEnv("PRBOT_TEST_GIT_REMOTE_PATH", remote);
  vi.stubEnv("GITHUB_TOKEN", ""); vi.stubEnv("GH_TOKEN", "");
  issueData = { title: "Telegram remote workflow", body: "Implement a stable Thread", comments: 1, state: "open" };
  repoData = { default_branch: "main", permissions: { push: true } }; existing = []; calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method || "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.hostname !== "api.github.com") throw new Error("Unexpected fixture network request");
    if (url.pathname.endsWith("/comments")) return Response.json([{ user: { login: "reviewer" }, body: "Keep the Issue open until review" }]);
    if (url.pathname.endsWith("/issues/14")) return Response.json(issueData);
    if (url.pathname.endsWith("/pulls")) return Response.json(method === "POST" ? { html_url: "https://github.com/Owner/project/pull/15" } : existing);
    if (url.pathname === "/repos/Owner/project") return Response.json(repoData);
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const issue = (): TelegramIssue => ({ owner: "Owner", repo: "project", number: 14, url: issueUrl, title: issueData.title, baseBranch: "main" });

describe("GitHub Issue validation", () => {
  it("accepts canonical Issue URLs and common credential-free GitHub remotes", () => {
    expect(parseIssueLink(` ${issueUrl}/?utm_source=telegram#comment `)).toMatchObject({ owner: "Owner", repo: "project", number: 14, url: issueUrl });
    for (const url of ["https://github.com/Owner/project.git", "git@github.com:Owner/project.git", "ssh://git@github.com/Owner/project.git"]) expect(githubRemote(url)).toEqual({ owner: "Owner", repo: "project" });
    for (const url of ["http://github.com/Owner/project/issues/14", "https://github.com.evil.test/Owner/project/issues/14", "https://token@github.com/Owner/project/issues/14", "https://github.com/Owner/project/issues", "https://github.com/Owner/project/pull/14", "https://github.com/Owner/project/issues/0", "https://github.com/Owner/project/issues/9007199254740992"]) expect(() => parseIssueLink(url)).toThrow();
    expect(() => githubRemote("https://token@github.com/Owner/project.git")).toThrow();
  });
  it("checks workspace ownership and confirmed write permission, and supplies body plus comments without SDK network", async () => {
    await writeFile(path.join(workspace, ".env"), "GITHUB_TOKEN=fixture-project-token\n");
    const detail = await inspectIssue(issueUrl, workspace);
    expect(detail.context).toContain(issueData.body); expect(detail.context).toContain("Keep the Issue open until review");
    expect(calls.every(call => call.authorization === "Bearer fixture-project-token")).toBe(true);
    calls.length = 0;
    await expect(inspectIssue("https://github.com/Other/repo/issues/14", workspace)).rejects.toThrow("origin");
    expect(calls).toHaveLength(0);
    repoData.permissions = undefined;
    await expect(inspectIssue(issueUrl, workspace)).rejects.toThrow("写入权限");
  });
  it("rejects closed issues, PR numbers and a separate push URL before starting work", async () => {
    issueData.state = "closed"; await expect(inspectIssue(issueUrl, workspace)).rejects.toThrow("打开的 Issue");
    issueData.state = "open"; issueData.pull_request = {}; await expect(inspectIssue(issueUrl, workspace)).rejects.toThrow("不能是 PR");
    delete issueData.pull_request;
    await git(workspace, ["remote", "set-url", "--push", "origin", "git@github.com:Other/repo.git"]);
    calls.length = 0;
    await expect(inspectIssue(issueUrl, workspace)).rejects.toThrow("推送地址");
    expect(calls).toHaveLength(0);
  });
  it("prepares an isolated feature branch from the fetched default branch and refuses dirty workspaces", async () => {
    await writeFile(path.join(workspace, "local.txt"), "unrelated edits");
    await expect(prepareIssue(workspace, issue(), "task-abcdef12")).rejects.toThrow("未提交改动");
    await rm(path.join(workspace, "local.txt"));
    const prepared = await prepareIssue(workspace, issue(), "task-abcdef12");
    expect(prepared).toEqual({ branch: "feature/prbot-issue-14-task-abc", baseBranch: "main" });
    expect(await git(workspace, ["branch", "--show-current"])).toBe(prepared.branch);
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(await git(workspace, ["rev-parse", "origin/main"]));
  });
  it("does not switch a branch after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareIssue(workspace, issue(), "cancelled", controller.signal)).rejects.toThrow();
    expect(await git(workspace, ["branch", "--show-current"])).toBe(branch);
    expect(calls).toHaveLength(0);
  });
});

describe("reviewed Git publication", () => {
  it("fingerprints new file contents including leading spaces and permits configuration examples", async () => {
    await writeFile(path.join(workspace, " leading space.txt"), "version one");
    await writeFile(path.join(workspace, ".env.example"), "GITHUB_TOKEN=\n");
    const first = await reviewSnapshot(workspace, branch);
    expect(first.hasChanges).toBe(true); expect(first.summary).toContain(" leading space.txt");
    await writeFile(path.join(workspace, " leading space.txt"), "version two");
    expect((await reviewSnapshot(workspace, branch)).fingerprint).not.toBe(first.fingerprint);
  });
  it("rejects a staged rename into a secret pathname", async () => {
    await rename(path.join(workspace, "README.md"), path.join(workspace, ".env.production"));
    await git(workspace, ["add", "--all"]);
    await expect(reviewSnapshot(workspace, branch)).rejects.toThrow("密钥文件");
  });
  it("rejects links outside the workspace and links to credentials without reading their contents", async () => {
    await writeFile(path.join(home, "private.txt"), "must remain private");
    await symlink(path.join(home, "private.txt"), path.join(workspace, "external"));
    await expect(reviewSnapshot(workspace, branch)).rejects.toThrow("链接");
    await rm(path.join(workspace, "external"));
    await writeFile(path.join(workspace, ".env"), "PRIVATE=secret\n");
    await symlink(".env", path.join(workspace, "internal"));
    await expect(reviewSnapshot(workspace, branch)).rejects.toThrow("链接");
  });
  it("refuses publication if files, the branch or origin change after confirmation", async () => {
    await writeFile(path.join(workspace, "feature.txt"), "reviewed\n");
    const snapshot = await reviewSnapshot(workspace, branch);
    await writeFile(path.join(workspace, "feature.txt"), "changed\n");
    await expect(publishIssue(workspace, issue(), branch, snapshot.fingerprint, async () => {})).rejects.toThrow("文件又变了");
    await git(workspace, ["remote", "set-url", "origin", "git@github.com:Other/repo.git"]);
    await expect(publishIssue(workspace, issue(), branch, snapshot.fingerprint, async () => {})).rejects.toThrow("origin");
    expect(calls.some(call => call.method === "POST")).toBe(false);
    await git(workspace, ["remote", "set-url", "origin", "git@github.com:Owner/project.git"]);
    await git(workspace, ["switch", "main"]);
    await expect(publishIssue(workspace, issue(), branch, snapshot.fingerprint, async () => {})).rejects.toThrow("分支已变化");
  });
  it("rechecks files after remote API calls and before staging", async () => {
    await writeFile(path.join(workspace, "feature.txt"), "reviewed\n");
    const snapshot = await reviewSnapshot(workspace, branch);
    const oldHead = await git(workspace, ["rev-parse", "HEAD"]);
    await expect(publishIssue(workspace, issue(), branch, snapshot.fingerprint, async stage => {
      if (stage === "committing") await writeFile(path.join(workspace, "feature.txt"), "unreviewed\n");
    })).rejects.toThrow("文件又变了");
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(oldHead);
  });
  it("commits and pushes to an isolated bare repo, then creates only a review PR", async () => {
    await writeFile(path.join(workspace, "feature.txt"), "reviewed implementation\n");
    const snapshot = await reviewSnapshot(workspace, branch);
    const stages: string[] = [];
    const url = await publishIssue(workspace, issue(), branch, snapshot.fingerprint, async value => { stages.push(value); });
    expect(url).toBe("https://github.com/Owner/project/pull/15");
    expect(stages).toEqual(["committing", "pushing", "creating_pr"]);
    expect(await git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(await git(workspace, ["rev-parse", "HEAD"]));
    expect(await readFile(path.join(workspace, "feature.txt"), "utf8")).toBe("reviewed implementation\n");
    const writes = calls.filter(call => call.method !== "GET");
    expect(writes).toHaveLength(1); expect(writes[0].url.pathname).toBe("/repos/Owner/project/pulls");
    expect(writes[0].body).toMatchObject({ head: branch, base: "main" });
    expect(String(writes[0].body?.body)).not.toMatch(/closes #|fixes #|resolves #/i);
  });
  it("reuses an existing PR after an uncertain response instead of creating another one", async () => {
    existing = [{ html_url: "https://github.com/Owner/project/pull/15" }];
    const snapshot = await reviewSnapshot(workspace, branch);
    const stages = vi.fn();
    expect(await publishIssue(workspace, issue(), branch, snapshot.fingerprint, stages)).toBe(existing[0].html_url);
    expect(stages).not.toHaveBeenCalled(); expect(calls.some(call => call.method === "POST")).toBe(false);
  });
  it("rechecks the push URL after committing and preserves the local commit if it was redirected", async () => {
    await writeFile(path.join(workspace, "feature.txt"), "reviewed\n");
    const snapshot = await reviewSnapshot(workspace, branch);
    await expect(publishIssue(workspace, issue(), branch, snapshot.fingerprint, async stage => {
      if (stage === "pushing") await git(workspace, ["remote", "set-url", "--push", "origin", "git@github.com:Other/repo.git"]);
    })).rejects.toThrow("推送地址");
    expect(await git(workspace, ["log", "-1", "--format=%s"])).toContain("Implement issue #14");
    expect(calls.some(call => call.method === "POST")).toBe(false);
  });
});
