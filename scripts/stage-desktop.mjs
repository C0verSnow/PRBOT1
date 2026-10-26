import { cp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(".desktop");
await rm(root, { recursive: true, force: true });
await mkdir(path.join(root, "app"), { recursive: true });
const { version } = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(path.join(root, "app/package.json"), JSON.stringify({
  name: "prbot1-desktop", productName: "PRBOT", version,
  description: "Local Codex chat workspace", main: "main.cjs",
  author: { name: "PRBOT contributors", email: "noreply@github.com" },
  homepage: "https://github.com/C0verSnow/PRBOT1",
}, null, 2));
await cp("desktop/main.cjs", path.join(root, "app/main.cjs"));
await cp(".next/standalone", path.join(root, "server"), { recursive: true, dereference: true });
await cp(".next/static", path.join(root, "server/.next/static"), { recursive: true });

// Explicitly copy the native package, even if Next's dependency tracer changes.
for (const name of await readdir("node_modules/@openai")) {
  if (name === "codex-sdk" || name === "codex" || name.startsWith("codex-")) {
    await cp(`node_modules/@openai/${name}`, path.join(root, "server/node_modules/@openai", name), { recursive: true, dereference: true });
  }
}
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name)))).flat();
}
const files = await walk(root);
if (files.some(p => path.basename(p).startsWith(".env") || p.includes(`${path.sep}.data${path.sep}`)))
  throw new Error("Runtime secrets/data must not be packaged");
const binary = files.find(p => p.includes(`${path.sep}vendor${path.sep}`) && ["codex", "codex.exe"].includes(path.basename(p)));
if (!binary) throw new Error("Codex native executable missing from standalone output");
// Executed only by remote delivery CI: prove the actual bundled CLI can run.
console.log(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim());
