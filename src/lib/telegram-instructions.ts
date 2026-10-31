import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "./telegram-github";

export type InstructionEvidence = { path: string; sha256: string; readAt: string };
/** Read before starting a writable Codex turn. Persist hashes, never instruction contents. */
export async function readIssueInstructions(workspace: string) {
  const root = await realpath(workspace);
  const ancestors: string[] = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    ancestors.unshift(path.join(dir, "AGENTS.md"));
    if (path.dirname(dir) === dir) break;
  }
  // Include nested tracked and untracked instruction files before any code edits.
  const nested = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "AGENTS.md", ":(glob)**/AGENTS.md"], undefined, true)).split("\0").filter(Boolean);
  const files = [...new Set([...ancestors, ...nested.map(file => path.resolve(root, file))])];
  const evidence: InstructionEvidence[] = []; const sections: string[] = [];
  let bytes = 0;
  for (const file of files) {
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error(`项目指令文件不是可直接读取的普通文件：${file}`);
    bytes += info.size;
    if (bytes > 256_000) throw new Error("项目指令文件过大，未启动代码修改，请先检查 AGENTS.md");
    const content = await readFile(file, "utf8");
    evidence.push({ path: file, sha256: createHash("sha256").update(content).digest("hex"), readAt: new Date().toISOString() });
    sections.push(`指令文件 ${file}（仅对所在目录及其子目录适用）：\n${content}`);
  }
  return { evidence, prompt: sections.join("\n\n") || "已检查上级目录和仓库，没有找到 AGENTS.md。" };
}
