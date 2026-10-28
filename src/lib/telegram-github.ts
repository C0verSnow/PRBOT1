import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TelegramIssue } from "./telegram-task-store";

const exec = promisify(execFile);
export async function git(workspace: string, args: string[], signal?: AbortSignal, raw = false) {
  const { stdout } = await exec("git", ["-C", workspace, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return raw ? stdout : stdout.trim();
}
export function parseIssueLink(text: string): TelegramIssue {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new Error("请发送完整的 GitHub Issue 链接，例如 https://github.com/owner/repo/issues/14"); }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !match || !Number.isSafeInteger(Number(match[3]))) throw new Error("只支持 github.com 上带具体编号的 HTTPS Issue 链接");
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/issues/${number}` };
}
export function githubRemote(remote: string) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) throw new Error("当前工作空间的 origin 必须是 github.com 仓库，且不能在地址里放密钥");
  return { owner: match[1], repo: match[2] };
}
async function githubToken(workspace: string) {
  let env: Record<string, string> = {};
  try { env = parseEnv(await readFile(path.join(workspace, ".env"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("项目 .env 无法读取"); }
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "";
}
async function github<T>(workspace: string, pathname: string, method = "GET", body?: object): Promise<T> {
  const token = await githubToken(workspace);
  const response = await fetch(`https://api.github.com${pathname}`, { method, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}），请检查仓库访问权限和 GITHUB_TOKEN`);
  return response.json() as Promise<T>;
}
async function checkedRemotes(workspace: string, issue: TelegramIssue) {
  const fetch = await git(workspace, ["remote", "get-url", "origin"]);
  const pushes = (await git(workspace, ["remote", "get-url", "--push", "--all", "origin"])).split("\n");
  for (const url of [fetch, ...pushes]) {
    const remote = githubRemote(url);
    if (`${remote.owner}/${remote.repo}`.toLowerCase() !== `${issue.owner}/${issue.repo}`.toLowerCase()) throw new Error("这个 Issue 不属于当前工作空间的 origin 仓库，或 origin 的推送地址指向另一个仓库，请先在本机检查");
  }
  if (pushes.length !== 1) throw new Error("origin 配置了多个推送地址，请先在本机保留一个明确的 GitHub 推送地址");
  return pushes[0];
}
export async function inspectIssue(text: string, workspace: string) {
  const issue = parseIssueLink(text);
  await checkedRemotes(workspace, issue);
  const prefix = `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}`;
  const [detail, repo] = await Promise.all([
    github<{ title: string; body?: string | null; comments?: number; state: string; pull_request?: unknown }>(workspace, `${prefix}/issues/${issue.number}`),
    github<{ default_branch: string; permissions?: { push?: boolean } }>(workspace, prefix),
  ]);
  if (detail.pull_request || detail.state !== "open") throw new Error("链接必须指向仍然打开的 Issue，不能是 PR");
  if (repo.permissions?.push !== true) throw new Error("当前 GitHub 身份没有确认这个仓库的写入权限，请在项目 .env 配置有写入权限的 GITHUB_TOKEN");
  const count = Number.isSafeInteger(detail.comments) && detail.comments! > 0 ? detail.comments! : 0;
  const lastPage = Math.max(1, Math.ceil(count / 50));
  const pages = count ? (lastPage > 1 ? [lastPage - 1, lastPage] : [1]) : [];
  const comments = (await Promise.all(pages.map(page => github<Array<{ body?: string; user?: { login?: string } }>>(workspace, `${prefix}/issues/${issue.number}/comments?per_page=50&page=${page}`)))).flat().slice(-50);
  const discussion = comments.map(comment => `${comment.user?.login || "GitHub 用户"}：\n${(comment.body || "").slice(0, 6000)}`).join("\n\n");
  const context = `标题：${detail.title}\n\nIssue 正文：\n${(detail.body || "（无正文）").slice(0, 30_000)}\n\n最近评论：\n${discussion.slice(-30_000) || "（无评论）"}\n\n[上下文只保留正文前 30,000 字符、最近 50 条评论的最后 30,000 字符；可能有截断。]`;
  return { ...issue, title: detail.title.slice(0, 200), baseBranch: repo.default_branch, context };
}
export async function prepareIssue(workspace: string, issue: TelegramIssue, taskId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await inspectIssue(issue.url, workspace); // Recheck access and workspace at the execution boundary.
  if (await git(workspace, ["status", "--porcelain"], signal)) throw new Error("工作区有未提交改动，请先在本机处理，Bot 不会覆盖这些文件");
  const base = current.baseBranch;
  await git(workspace, ["check-ref-format", "--branch", base], signal);
  signal?.throwIfAborted();
  await git(workspace, ["fetch", "origin", base], signal);
  const branch = `feature/prbot-issue-${issue.number}-${taskId.slice(0, 8)}`;
  signal?.throwIfAborted();
  await git(workspace, ["switch", "-c", branch, "FETCH_HEAD"], signal);
  return { branch, baseBranch: base };
}
function sensitivePath(file: string) {
  return file.split(/[\\/]/).some(part => {
    if (/^\.env\.(?:example|sample|template)$/i.test(part)) return false;
    return /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key))$/i.test(part);
  });
}
function statusPaths(status: string) {
  const entries = status.split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Git 工作区状态格式不正确，请在本机检查");
    files.push(entry.slice(3));
    // In porcelain -z output a rename/copy is destination NUL source NUL.
    if (/[RC]/.test(entry.slice(0, 2))) {
      const source = entries[++index];
      if (!source) throw new Error("Git 重命名状态格式不正确，请在本机检查");
      files.push(source);
    }
  }
  return [...new Set(files)];
}
async function checkedFile(workspace: string, file: string) {
  const root = await realpath(workspace);
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("改动文件不在工作空间内，请在本机检查");
  if (sensitivePath(file)) throw new Error("改动中包含可能的密钥文件，请先在本机处理，Bot 不会发布");
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink()) {
    const target = await readlink(absolute);
    const destination = path.resolve(path.dirname(absolute), target);
    const scope = path.relative(root, destination);
    if (!scope || scope === ".." || scope.startsWith(`..${path.sep}`) || path.isAbsolute(scope) || sensitivePath(scope)) throw new Error("改动中有指向工作空间外或密钥文件的链接，请先在本机处理，Bot 不会发布");
    let resolved: string;
    try { resolved = await realpath(absolute); }
    catch { throw new Error("改动中的链接目标无法确认，请先在本机处理，Bot 不会发布"); }
    const resolvedScope = path.relative(root, resolved);
    if (!resolvedScope || resolvedScope === ".." || resolvedScope.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedScope) || sensitivePath(resolvedScope)) throw new Error("改动中有指向工作空间外或密钥文件的链接，请先在本机处理，Bot 不会发布");
    return { kind: "symlink", contents: target };
  }
  if (!info.isFile()) throw new Error("改动中有无法安全读取的特殊文件，请先在本机处理，Bot 不会发布");
  const resolved = await realpath(absolute);
  const resolvedScope = path.relative(root, resolved);
  if (!resolvedScope || resolvedScope === ".." || resolvedScope.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedScope) || sensitivePath(resolvedScope)) throw new Error("改动文件实际位于工作空间外或密钥目录，请先在本机处理，Bot 不会发布");
  return { kind: "file", contents: resolved };
}
export async function reviewSnapshot(workspace: string, branch: string) {
  if (await git(workspace, ["branch", "--show-current"]) !== branch) throw new Error("当前分支已变化，请在本机检查后再继续");
  const status = await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], undefined, true);
  // Do not publish secrets even when a project forgot its .gitignore.
  for (const file of statusPaths(status)) await checkedFile(workspace, file);
  const diff = await git(workspace, ["diff", "HEAD", "--binary"], undefined, true);
  const untracked = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], undefined, true);
  const contents = await Promise.all(untracked.split("\0").filter(Boolean).map(async file => {
    const checked = await checkedFile(workspace, file);
    if (!checked) throw new Error("改动文件在检查时消失，请重新检查后再发布");
    return createHash("sha256").update(checked.kind === "symlink" ? `symlink:${checked.contents}` : await readFile(checked.contents)).digest("hex");
  }));
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  return { fingerprint: createHash("sha256").update(JSON.stringify([head, status, diff, untracked, contents])).digest("hex"), summary: (await git(workspace, ["diff", "--stat", "HEAD"])) || statusPaths(status).join("\n") || "工作区没有文件改动", hasChanges: !!status };
}
export async function publishIssue(workspace: string, issue: TelegramIssue, branch: string, fingerprint: string, stage: (name: string) => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await inspectIssue(issue.url, workspace);
  if (current.baseBranch !== issue.baseBranch) throw new Error("仓库默认分支已变化，请重新检查并确认发布");
  const snapshot = await reviewSnapshot(workspace, branch);
  if (snapshot.fingerprint !== fingerprint) throw new Error("确认之后文件又变了，请重新检查改动并确认发布");
  const prefix = `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}`;
  // A failed POST can have succeeded on GitHub: query by head before retrying.
  const existing = await github<Array<{ html_url: string }>>(workspace, `${prefix}/pulls?state=open&head=${encodeURIComponent(`${issue.owner}:${branch}`)}`);
  if (existing[0]) return existing[0].html_url;
  signal?.throwIfAborted();
  await stage("committing");
  // Access checks and PR lookup may take time; require the same reviewed files at staging.
  if ((await reviewSnapshot(workspace, branch)).fingerprint !== fingerprint) throw new Error("确认之后文件又变了，请重新检查改动并确认发布");
  if (snapshot.hasChanges) {
    await git(workspace, ["add", "--all"]);
    await git(workspace, ["commit", "-m", `Implement issue #${issue.number} via PRBOT`]);
  }
  if (!await git(workspace, ["log", `origin/${issue.baseBranch}..HEAD`, "--oneline"])) throw new Error("没有可交付的提交，无法创建 PR");
  await stage("pushing");
  signal?.throwIfAborted();
  if (await git(workspace, ["branch", "--show-current"]) !== branch) throw new Error("当前分支已变化，请在本机检查后再继续");
  const pushUrl = await checkedRemotes(workspace, issue);
  // Bind the push to the checked URL; a concurrent origin edit cannot redirect it.
  await git(workspace, ["push", "--set-upstream", pushUrl, branch]);
  await stage("creating_pr");
  signal?.throwIfAborted();
  const pr = await github<{ html_url: string }>(workspace, `${prefix}/pulls`, "POST", { title: `Issue #${issue.number}: ${issue.title || "Codex changes"}`, head: branch, base: issue.baseBranch, body: `Implements ${issue.url}\n\nCreated by the Telegram Codex workflow. Please review the diff and remote CI results before merging.\n\nNo automatic merge or issue closure. Local compilation/testing was not requested by this workflow; repository instructions apply.` });
  return pr.html_url;
}
