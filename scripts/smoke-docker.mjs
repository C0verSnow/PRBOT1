// Remote CI only: run the built image, traverse HTTP -> SDK -> subprocess, then recreate it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const name = "prbot-delivery-test";
const base = "http://127.0.0.1:3210";
const start = () => docker("run", "-d", "--init", "--name", name, "-p", "127.0.0.1:3210:3000",
  "-v", "prbot-test-chats:/data", "-v", "prbot-test-workspace:/workspace",
  "--mount", `type=bind,source=${path.resolve("scripts")},target=/fixture,readonly`,
  "-e", "CODEX_PATH_OVERRIDE=/fixture/fake-codex.mjs", "prbot1:ci");
async function ready() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Container startup timeout");
}
try {
  start(); await ready();
  assert.equal(docker("exec", name, "id", "-u"), "1000");
  docker("exec", name, "node", "--input-type=module", "-e", `
    import { Codex } from '@openai/codex-sdk';
    import { readdirSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    new Codex();
    const root='/app/node_modules/@openai/';
    const binary=readdirSync(root,{recursive:true}).find(p=>p.includes('/vendor/')&&p.endsWith('/bin/codex'));
    if(!binary) throw new Error('Native CLI missing');
    console.log(execFileSync(root+binary,['--version'],{encoding:'utf8'}));
  `);
  assert.equal((await fetch(`${base}/api/chats`, { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  const created = await fetch(`${base}/api/chats`, { method: "POST" });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const turn = await fetch(`${base}/api/chats/${id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "写入测试文件" }) });
  assert.equal(turn.status, 200);
  assert.match(await turn.text(), /你好！我已连接到当前项目/);
  assert.match(docker("exec", name, "cat", "/workspace/sdk-evidence.txt"), /written through SDK/);
  docker("rm", "-f", name);
  start(); await ready();
  const history = await (await fetch(`${base}/api/chats/${id}`)).json();
  assert.match(JSON.stringify(history), /你好！我已连接到当前项目/);
  console.log("Container: non-root, native CLI, HTTP/SDK/file write, recreate persistence passed");
} finally {
  try { console.log(docker("logs", name)); } catch { /* may already be removed */ }
  try { docker("rm", "-f", name); } catch { /* preserve original failure */ }
  docker("volume", "rm", "prbot-test-chats", "prbot-test-workspace");
}
