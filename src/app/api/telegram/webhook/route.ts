import { createHash, timingSafeEqual } from "node:crypto";
import { body, HttpError } from "@/lib/http";
import { handleTelegramUpdate, isTelegramUpdate, telegramConnection } from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // This endpoint is for Telegram, so the browser/local-only guard deliberately does not apply.
  const secret = process.env.PRBOT_TELEGRAM_WEBHOOK_SECRET || "";
  if (process.env.PRBOT_TELEGRAM_TRANSPORT !== "webhook" || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) return Response.json({ error: "Webhook 未启用或配置不完整" }, { status: 503 });
  const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!provided || !timingSafeEqual(digest(secret), digest(provided))) return Response.json({ error: "Webhook 身份验证失败" }, { status: 403 });
  try {
    const input = await body(request);
    if (!isTelegramUpdate(input)) throw new HttpError(400, "Telegram 更新格式不正确");
    const connection = await telegramConnection();
    if (!connection) return Response.json({ ok: true });
    // Durable intake/queue only: never hold a webhook request open for a Codex turn or a reply.
    await handleTelegramUpdate(input, connection.credentials, connection.key, connection.settings.allowedUsers.split(",").map(value => value.trim()), { waitForReply: false });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof HttpError ? error.message : "Telegram 更新暂时无法接收，请稍后重试" }, { status: error instanceof HttpError ? error.status : 503 });
  }
}
