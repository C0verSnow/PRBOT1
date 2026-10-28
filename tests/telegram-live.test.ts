import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { telegramCredentials } from "../src/lib/infisical";
import { telegramRequest } from "../src/lib/telegram-api";

// Opt-in remote CI only: use organization Infisical credentials, never poll updates,
// send Telegram messages, touch a workspace or call a paid model.
describe.skipIf(process.env.PRBOT_LIVE_SERVICES !== "1")("live Infisical → Telegram identity / Upstash connectivity", () => {
  it("reads existing PR_BOT_TOKEN and checks the real services without exposing values", async () => {
    for (const name of ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_PROJECT_ID"]) {
      if (!process.env[name]) throw new Error(`远端 CI 缺少组织 Secret：${name}`);
    }
    const settings = { enabled: true, projectId: process.env.INFISICAL_PROJECT_ID!, clientId: process.env.INFISICAL_CLIENT_ID!, clientSecret: process.env.INFISICAL_CLIENT_SECRET!, environment: process.env.INFISICAL_ENVIRONMENT || "prod", allowedUsers: "1" };
    const credentials = await telegramCredentials(settings);
    const identity = await telegramRequest<{ is_bot: boolean; id: number }>(credentials.botToken, "getMe", {});
    expect(identity.is_bot).toBe(true); expect(Number.isSafeInteger(identity.id)).toBe(true);
    async function redis(args: (string | number)[]) {
      const response = await fetch(credentials.url, { method: "POST", headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("真实 Upstash HTTP 请求未通过");
      const result = await response.json() as { result?: unknown; error?: string };
      if (result.error) throw new Error("真实 Upstash 命令未通过");
      return result.result;
    }
    expect(await redis(["PING"])).toBe("PONG");
    const key = `prbot:livecheck:${randomUUID()}`;
    try {
      expect(await redis(["SET", key, "fixture", "NX", "EX", 60])).toBe("OK");
      expect(await redis(["SET", key, "duplicate", "NX", "EX", 60])).toBeNull();
      expect(await redis(["GET", key])).toBe("fixture");
    } finally { await redis(["DEL", key]); }
  }, 90_000);
});
