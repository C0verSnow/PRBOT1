import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET as config } from "../src/app/api/config/route";
import { GET as list, POST as create } from "../src/app/api/chats/route";
import { GET as read, DELETE as remove } from "../src/app/api/chats/[id]/route";
import { POST as send } from "../src/app/api/chats/[id]/turn/route";
import { reserve } from "../src/lib/runner";
function request(method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/chats", { method, headers: { host: "127.0.0.1:3000", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "prbot-route-"));
  vi.stubEnv("PRBOT_DATA_DIR", directory); vi.stubEnv("CODEX_WORKSPACE", directory); vi.stubEnv("CODEX_API_KEY", "private-server-key");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
describe("route contracts", () => {
  it("reports full access and never serializes credentials", async () => {
    const response = await config(request()); const data = await response.json();
    expect(response.status).toBe(200); expect(data.access).toBe("danger-full-access");
    expect(JSON.stringify(data)).not.toContain("private-server-key");
    expect(Object.keys(data).sort()).toEqual(["access", "codexHome", "codexPath", "effort", "model", "modelId", "recentWorkspaces", "speed", "workspace"]);
  });
  it("persists, lists, reads and deletes a chat", async () => {
    const created = await create(request("POST")); expect(created.status).toBe(201);
    const chat = await created.json(); const ctx = { params: Promise.resolve({ id: chat.id }) };
    expect((await (await list(request())).json())[0].id).toBe(chat.id);
    expect((await (await read(request(), ctx)).json()).messages).toEqual([]);
    expect((await remove(request("DELETE"), ctx)).status).toBe(204);
    expect((await read(request(), ctx)).status).toBe(404);
  });
  it("rejects empty/long prompts before launching any SDK process", async () => {
    const { id } = await (await create(request("POST"))).json(); const ctx = { params: Promise.resolve({ id }) };
    for (const prompt of [" ", "a".repeat(16001), 123]) expect((await send(request("POST", { prompt }), ctx)).status).toBe(400);
    expect((await (await read(request(), ctx)).json()).messages).toEqual([]);
  });
  it("rejects deletion during execution", async () => {
    const { id } = await (await create(request("POST"))).json(); const ctx = { params: Promise.resolve({ id }) };
    const lock = reserve(id);
    try { expect((await remove(request("DELETE"), ctx)).status).toBe(409); }
    finally { lock.release(); }
  });
  it("blocks a cross-site create without changing history", async () => {
    expect((await create(request("POST", undefined, { origin: "https://example.com" }))).status).toBe(403);
    expect(await (await list(request())).json()).toEqual([]);
  });
});
