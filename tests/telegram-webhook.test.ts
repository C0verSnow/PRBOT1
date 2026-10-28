import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ receive: vi.fn(), connection: vi.fn() }));
vi.mock("../src/lib/telegram-bot", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/telegram-bot")>(), handleTelegramUpdate: mocks.receive, telegramConnection: mocks.connection,
}));
import { POST } from "../src/app/api/telegram/webhook/route";
const secret = "webhook-private-secret-abcdefghijkl";
function request(value: unknown = { update_id: 1 }, token = secret) {
  return new Request("https://public.example/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": token }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.stubEnv("PRBOT_TELEGRAM_TRANSPORT", "webhook"); vi.stubEnv("PRBOT_TELEGRAM_WEBHOOK_SECRET", secret);
  mocks.receive.mockReset().mockResolvedValue(undefined);
  mocks.connection.mockReset().mockResolvedValue({ credentials: { botToken: "123:token", url: "https://example.upstash.io", token: "redis" }, settings: { allowedUsers: "123, 456" }, key: "settings-key" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Telegram webhook boundary", () => {
  it("rejects missing/wrong secrets before reading credentials or accepting an update", async () => {
    expect((await POST(request({ update_id: 1 }, ""))).status).toBe(403);
    expect((await POST(request({ update_id: 1 }, "wrong"))).status).toBe(403);
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.receive).not.toHaveBeenCalled();
  });
  it("requires explicit webhook mode and a sufficiently long secret", async () => {
    vi.stubEnv("PRBOT_TELEGRAM_TRANSPORT", "polling"); expect((await POST(request())).status).toBe(503);
    vi.stubEnv("PRBOT_TELEGRAM_TRANSPORT", "webhook"); vi.stubEnv("PRBOT_TELEGRAM_WEBHOOK_SECRET", "short");
    expect((await POST(request())).status).toBe(503); expect(mocks.receive).not.toHaveBeenCalled();
  });
  it("accepts authenticated Telegram requests on a public hostname after durable intake", async () => {
    const update = { update_id: 7, message: { text: "/status", from: { id: 123 }, chat: { id: 123, type: "private" } } };
    const response = await POST(request(update));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(mocks.receive).toHaveBeenCalledWith(update, expect.anything(), "settings-key", ["123", "456"], { waitForReply: false });
  });
  it("rejects malformed and oversized bodies without accepting an update", async () => {
    expect((await POST(request({ update_id: "1" }))).status).toBe(400);
    expect((await POST(request({ update_id: -1 }))).status).toBe(400);
    expect((await POST(request({ update_id: 1, message: { chat: null } }))).status).toBe(400);
    expect((await POST(request({ update_id: 1, callback_query: { id: "q", from: null } }))).status).toBe(400);
    expect((await POST(request({ update_id: 1, data: "x".repeat(64_001) }))).status).toBe(413);
    expect(mocks.receive).not.toHaveBeenCalled();
  });
  it("allows Telegram to retry if durable intake is unavailable without exposing errors", async () => {
    mocks.receive.mockRejectedValue(new Error("Bearer private-token"));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private-token");
  });
});
