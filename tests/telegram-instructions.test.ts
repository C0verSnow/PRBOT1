import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { git } from "../src/lib/telegram-github";
import { readIssueInstructions } from "../src/lib/telegram-instructions";
let parent: string; let workspace: string;
beforeEach(async () => {
  parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prbot-instructions-")));
  workspace = path.join(parent, "repo"); await mkdir(workspace); await git(workspace, ["init"]);
});
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
describe("pre-edit instruction reading evidence", () => {
  it("reads ancestor, root and nested instructions in order with reproducible hashes", async () => {
    await writeFile(path.join(parent, "AGENTS.md"), "禁止本地编译");
    await writeFile(path.join(workspace, "AGENTS.md"), "记录过程");
    await mkdir(path.join(workspace, "src")); await writeFile(path.join(workspace, "src", "AGENTS.md"), "子目录规则");
    const result = await readIssueInstructions(workspace);
    const records = result.evidence.filter(item => item.path.startsWith(parent));
    expect(records.map(item => path.relative(parent, item.path))).toEqual(["AGENTS.md", "repo/AGENTS.md", "repo/src/AGENTS.md"]);
    for (const record of records) {
      expect(record.sha256).toBe(createHash("sha256").update(await readFile(record.path)).digest("hex"));
      expect(Number.isNaN(Date.parse(record.readAt))).toBe(false);
    }
    expect(result.prompt).toContain("禁止本地编译"); expect(result.prompt).toContain("子目录规则");
    expect(JSON.stringify(records)).not.toContain("禁止本地编译");
  });
  it("does not follow a symlink masquerading as AGENTS.md", async () => {
    await writeFile(path.join(parent, "other.md"), "external instructions");
    await symlink(path.join(parent, "other.md"), path.join(workspace, "AGENTS.md"));
    await expect(readIssueInstructions(workspace)).rejects.toThrow("普通文件");
  });
});
