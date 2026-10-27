// Remote delivery CI only. Inspect the final DMG app before starting it.
// electron-builder signing design and upstream issue comparison: docs/issue-12.md.
import { execFileSync } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native Apple Silicon runner required");
const executable = process.env.APP_EXECUTABLE;
const resources = process.env.APP_RESOURCES;
if (!executable || !resources) throw new Error("Installed application paths required");
const app = path.resolve(path.dirname(executable), "../..");
const openai = path.join(resources, "server/node_modules/@openai");
const files = await readdir(openai, { recursive: true });
const codex = files.find(file => file.endsWith("vendor/aarch64-apple-darwin/codex/codex"));
if (!codex) throw new Error("Installed macOS arm64 Codex executable missing");
const native = path.join(openai, codex);
for (const binary of [executable, native]) execFileSync("lipo", ["-verify_arch", "arm64", binary], { stdio: "inherit" });
// Checks the sealed resources and nested Electron helpers, not just the main Mach-O.
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
const signature = execFileSync("codesign", ["--display", "--verbose=4", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const version = execFileSync(native, ["--version"], { encoding: "utf8" }).trim();
await mkdir("test-results/desktop", { recursive: true });
await writeFile("test-results/desktop/macos-integrity.json", JSON.stringify({
  arch: process.arch, app, native, version, signature,
  verification: "codesign --verify --deep --strict passed",
  gatekeeper: "Ad-hoc signature; not Developer ID signed or notarized. First-open approval may be required.",
}, null, 2));
console.log("Installed macOS app: arm64 Electron, arm64 Codex and bundle signature verified");
