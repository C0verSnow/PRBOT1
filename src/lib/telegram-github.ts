import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TelegramIssue } from "./telegram-task-store";
import { pluginInspectIssue, pluginEnsurePullRequest } from "./telegram-github-plugin";

const exec = promisify(execFile);
export async function git(workspace: string, args: string[], signal?: AbortSignal, raw = false) {
  const { stdout } = await exec("git", ["-C", workspace, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return raw ? stdout : stdout.trim();
}
export function parseIssueLink(text: string): TelegramIssue {
  // Deduplicate the label and destination in (even nested) Markdown links.
  // Consume the whole URL token so malformed paths cannot become valid prefixes.
  const candidates = text.trim().match(/https?:\/\/[^\s<>\[\]()]+/gi) || [];
  if (!candidates.length) throw new Error("请发送完整的 GitHub Issue 链接，例如 https://github.com/owner/repo/issues/14");
  const issues = candidates.map(candidate => parseIssueURL(candidate));
  if (new Set(issues.map(issue => issue.url.toLowerCase())).size !== 1) throw new Error("一次只能发送一个 GitHub Issue 链接，请说明要完成哪一个");
  return issues[0];
}
function parseIssueURL(text: string): TelegramIssue {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new Error("请发送完整的 GitHub Issue 链接，例如 https://github.com/owner/repo/issues/14"); }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !match || [match[1], match[2]].some(part => part === "." || part === "..") || !Number.isSafeInteger(Number(match[3]))) throw new Error("只支持 github.com 上带具体编号的 HTTPS Issue 链接");
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/issues/${number}` };
}
export function githubRemote(remote: string) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) throw new Error("当前工作空间的 origin 必须是 github.com 仓库，且不能在地址里放密钥");
  return { owner: match[1], repo: match[2] };
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
async function entry(location: string) {
  try { return await lstat(location); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function repositoryRoot(workspace: string, issue: TelegramIssue, signal?: AbortSignal) {
  // Checking .git alone is insufficient: it can be a broken directory or a worktree file.
  const top = await git(workspace, ["rev-parse", "--show-toplevel"], signal);
  if (await realpath(top) !== await realpath(workspace)) throw new Error("目标目录不是独立的 Git 仓库，请检查 .git；不会使用上层仓库");
  await checkedRemotes(workspace, issue);
}
/** Borrowed lifecycle design: cli/cli repo clone + actions/checkout; see docs/issue-19.md. */
export async function ensureIssueRepository(workspace: string, issue: TelegramIssue, signal?: AbortSignal, options: { repositoryPath?: string; requireExisting?: boolean; beforePrepare?: (target: string) => Promise<void> } = {}) {
  signal?.throwIfAborted();
  const root = await realpath(workspace);
  // Canonical parsing also excludes path traversal when loading a persisted task.
  const identity = parseIssueLink(issue.url);
  if (`${identity.owner}/${identity.repo}`.toLowerCase() !== `${issue.owner}/${issue.repo}`.toLowerCase() || identity.number !== issue.number) throw new Error("任务的 Issue 信息不一致，请检查后重试");
  const target = options.repositoryPath || (await entry(path.join(root, ".git")) ? root : path.join(root, identity.owner, identity.repo));
  const child = path.join(root, identity.owner, identity.repo);
  if (target !== root && target !== child) throw new Error("保存的仓库目录不属于这个任务，请在本机检查");
  await options.beforePrepare?.(target);
  if (target !== root) {
    const ownerPath = path.dirname(target);
    if (!await entry(ownerPath)) await mkdir(ownerPath).catch(error => { if (error.code !== "EEXIST") throw error; });
    const owner = await entry(ownerPath);
    if (!owner?.isDirectory() || owner.isSymbolicLink() || await realpath(ownerPath) !== ownerPath) throw new Error("目标仓库的上层目录不安全，请检查目录或符号链接");
  }
  const info = await entry(target);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("目标仓库路径被文件或符号链接占用，Bot 不会覆盖");
  if (await entry(path.join(target, ".git"))) {
    await repositoryRoot(target, issue, signal);
    return target;
  }
  if (options.requireExisting) throw new Error("原任务的 Git 仓库已缺失，请恢复原目录；Bot 不会重新克隆并重做已执行的操作");
  if (info && (await readdir(target)).length) throw new Error("目标目录不是 Git 仓库且已有文件，Bot 不会覆盖或执行 git init，请先在本机处理");
  if (!info) await mkdir(target); // Exclusive claim; never reuse a concurrently created directory.
  signal?.throwIfAborted();
  try {
    // Clone into an empty directory only. Git also refuses it if files appeared meanwhile.
    await git(root, ["clone", "--", `https://github.com/${identity.owner}/${identity.repo}.git`, target], signal);
    await repositoryRoot(target, issue, signal);
  } catch (error) {
    // Only remove an empty directory. Any partial checkout is retained for inspection.
    await rmdir(target).catch(() => {});
    throw error;
  }
  return target;
}
export async function inspectIssue(text: string, workspace: string, signal?: AbortSignal, allowClosed = false) {
  const issue = parseIssueLink(text);
  await checkedRemotes(workspace, issue);
  const detail = await pluginInspectIssue(workspace, issue, signal);
  if (!detail.canRead) throw new Error("GitHub 插件无法读取这个 Issue，请检查已连接账号的仓库权限");
  if (detail.isPullRequest || !detail.isOpen && !allowClosed) throw new Error("链接必须指向仍然打开的 Issue，不能是 PR");
  if (!detail.canWrite) throw new Error("GitHub 插件没有确认当前账号的仓库写入权限，请检查插件连接和仓库授权");
  await git(workspace, ["check-ref-format", "--branch", detail.defaultBranch]);
  return { ...issue, title: detail.title.slice(0, 200), baseBranch: detail.defaultBranch, context: detail.context.slice(0, 60_000), closePolicy: detail.closePolicy || "keep_open" };
}
export async function prepareIssue(workspace: string, issue: TelegramIssue, taskId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await inspectIssue(issue.url, workspace, signal); // Recheck access and workspace at the execution boundary.
  const branch = `feature/prbot-issue-${issue.number}-${taskId.slice(0, 8)}`;
  const branches = await git(workspace, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], signal);
  if (branches.split("\n").includes(`refs/heads/${branch}`)) {
    if (await git(workspace, ["branch", "--show-current"], signal) !== branch) throw new Error("任务的 Feature 分支已经存在但当前分支不同，请在本机检查后切回，Bot 不会重建或覆盖");
    return { branch, baseBranch: current.baseBranch, baseSha: await git(workspace, ["merge-base", `origin/${current.baseBranch}`, "HEAD"], signal) }; // A switch may have succeeded before its checkpoint was saved.
  }
  if (await git(workspace, ["status", "--porcelain"], signal)) throw new Error("工作区有未提交改动，请先在本机处理，Bot 不会覆盖这些文件");
  const base = current.baseBranch;
  await git(workspace, ["check-ref-format", "--branch", base], signal);
  signal?.throwIfAborted();
  await git(workspace, ["fetch", "origin", base], signal);
  signal?.throwIfAborted();
  await git(workspace, ["switch", "-c", branch, "FETCH_HEAD"], signal);
  return { branch, baseBranch: base, baseSha: await git(workspace, ["rev-parse", "HEAD"], signal) };
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
export async function publishIssue(workspace: string, issue: TelegramIssue, branch: string, fingerprint: string, stage: (name: string) => Promise<void>, signal?: AbortSignal, committedSha?: string, expectedTree?: string) {
  signal?.throwIfAborted();
  const current = await inspectIssue(issue.url, workspace, signal, true);
  if (current.baseBranch !== issue.baseBranch) throw new Error("仓库默认分支已变化，请重新检查并确认发布");
  const snapshot = await reviewSnapshot(workspace, branch);
  if (snapshot.fingerprint !== fingerprint && !(!snapshot.hasChanges && (committedSha && await git(workspace, ["rev-parse", "HEAD"], signal) === committedSha || expectedTree && await git(workspace, ["rev-parse", "HEAD^{tree}"], signal) === expectedTree))) throw new Error("确认之后文件又变了，请重新检查改动并确认发布");
  // A failed POST can have succeeded on GitHub: query by head before retrying.
  const existing = await pluginEnsurePullRequest(workspace, issue, branch, issue.baseBranch!, false, signal);
  if (existing && !snapshot.hasChanges) {
    const pushUrl = await checkedRemotes(workspace, issue);
    const published = await git(workspace, ["ls-remote", pushUrl, `refs/heads/${branch}`], signal);
    const head = await git(workspace, ["rev-parse", "HEAD"], signal);
    // A clean tree can still contain a local commit from an interrupted push.
    if (published.split(/\s+/)[0] === head) return existing;
  }
  signal?.throwIfAborted();
  await stage("committing");
  // Access checks and PR lookup may take time; require the same reviewed files at staging.
  if ((await reviewSnapshot(workspace, branch)).fingerprint !== snapshot.fingerprint) throw new Error("确认之后文件又变了，请重新检查改动并确认发布");
  if (snapshot.hasChanges) {
    await git(workspace, ["add", "--all"], signal);
    const staged = await git(workspace, ["write-tree"], signal);
    await stage("staged");
    if (await git(workspace, ["write-tree"], signal) !== staged || await git(workspace, ["diff", "--name-only"], signal) || await git(workspace, ["ls-files", "--others", "--exclude-standard"], signal)) throw new Error("暂存之后文件又变了，请检查后再发布");
    await git(workspace, ["commit", "-m", `Implement issue #${issue.number} via PRBOT`], signal);
  }
  await stage("committed");
  if (!await git(workspace, ["log", `origin/${issue.baseBranch}..HEAD`, "--oneline"])) throw new Error("没有可交付的提交，无法创建 PR");
  await stage("pushing");
  signal?.throwIfAborted();
  if (await git(workspace, ["branch", "--show-current"]) !== branch) throw new Error("当前分支已变化，请在本机检查后再继续");
  const pushUrl = await checkedRemotes(workspace, issue);
  // Bind the push to the checked URL; a concurrent origin edit cannot redirect it.
  await git(workspace, ["push", "--set-upstream", pushUrl, branch], signal);
  if (existing) return existing;
  await stage("creating_pr");
  signal?.throwIfAborted();
  const url = await pluginEnsurePullRequest(workspace, issue, branch, issue.baseBranch!, true, signal);
  if (!url) throw new Error("GitHub 插件没有确认 PR 已创建，请检查后续接，避免重复创建");
  return url;
}
