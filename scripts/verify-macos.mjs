// Remote delivery CI only. Inspect the final DMG app before starting it.
// electron-builder signing design and upstream issue comparison: docs/issue-12.md.
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native Apple Silicon runner required");
const executable = process.env.APP_EXECUTABLE;
const resources = process.env.APP_RESOURCES;
if (!executable || !resources) throw new Error("Installed application paths required");
const app = path.resolve(path.dirname(executable), "../..");
const openai = path.join(resources, "server/node_modules/@openai");
const files = await readdir(openai, { recursive: true });
const codex = files.find(file => /vendor\/aarch64-apple-darwin\/(?:bin|codex)\/codex$/.test(file));
if (!codex) throw new Error("Installed macOS arm64 Codex executable missing");
const native = path.join(openai, codex);
// Checks the sealed resources and nested Electron helpers, not just the main Mach-O.
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
for (const binary of [executable, native]) execFileSync("lipo", [binary, "-verify_arch", "arm64"], { stdio: "inherit" });
// codesign writes display information to stderr even on success.
const displayed = spawnSync("codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
if (displayed.error) throw displayed.error;
if (displayed.status !== 0) throw new Error("Cannot inspect macOS signature");
const signature = displayed.stderr;
if (!signature.includes("Signature=adhoc")) throw new Error("Expected configured ad-hoc signature");
const version = execFileSync(native, ["--version"], { encoding: "utf8" }).trim();
await mkdir("test-results/desktop", { recursive: true });
await writeFile("test-results/desktop/macos-integrity.json", JSON.stringify({
  arch: process.arch, app, native, version, signature,
  verification: "codesign --verify --deep --strict passed",
  gatekeeper: "Ad-hoc signature; not Developer ID signed or notarized. First-open approval may be required.",
}, null, 2));
console.log("Installed macOS app: arm64 Electron, arm64 Codex and bundle signature verified");
