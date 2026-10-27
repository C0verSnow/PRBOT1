import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET, PUT } from "../src/app/api/telegram/settings/route";
import { telegramCredentials } from "../src/lib/infisical";
let root: string;
const input = { enabled: true, projectId: "project", clientId: "client", clientSecret: "private-secret", environment: "prod", allowedUsers: "123, 456" };
function update(value: unknown, origin?: string) {
  return PUT(new Request("http://127.0.0.1/api/telegram/settings", { method: "PUT", headers: { host: "127.0.0.1", ...(origin ? { origin } : {}) }, body: JSON.stringify(value) }));
}
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prbot-tg-")); vi.stubEnv("PRBOT_DATA_DIR", root); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
describe("Telegram settings", () => {
  it("saves the secret privately, never returns it, and retains it on a blank update", async () => {
    expect((await update(input)).status).toBe(200);
    const response = await GET(new Request("http://127.0.0.1/api/telegram/settings", { headers: { host: "127.0.0.1" } }));
    const value = await response.json();
    expect(value.hasClientSecret).toBe(true); expect(JSON.stringify(value)).not.toContain(input.clientSecret);
    expect((await update({ ...input, clientSecret: "" })).status).toBe(200);
    expect(JSON.parse(await readFile(path.join(root, "telegram-settings.json"), "utf8")).clientSecret).toBe(input.clientSecret);
  });
  it("rejects invalid allowlists and cross-site changes", async () => {
    expect((await update({ ...input, allowedUsers: "anyone" })).status).toBe(400);
    expect((await update(input, "https://example.com")).status).toBe(403);
  });
  it("fetches named secrets using universal authentication without exposing them in errors", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.includes("universal-auth/login")) return Response.json({ accessToken: "access" });
      if (address.includes("TELEGRAM_BOT_TOKEN")) return Response.json({ secret: { secretValue: "123:token" } });
      if (address.includes("UPSTASH_REDIS_REST_URL")) return Response.json({ secret: { secretValue: "https://example.upstash.io" } });
      return Response.json({ secret: { secretValue: "redis-secret" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await telegramCredentials(input);
    expect(result.botToken).toBe("123:token"); expect(result.url).toBe("https://example.upstash.io/"); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
