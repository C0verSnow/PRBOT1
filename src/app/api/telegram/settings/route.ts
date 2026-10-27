import { body, failure, guard } from "@/lib/http";
import { changeSettings } from "@/lib/runtime-state";
import { publicTelegramSettings, readTelegramSettings, saveTelegramSettings } from "@/lib/telegram-settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json(publicTelegramSettings(await readTelegramSettings())); }
  catch (e) { return failure(e); }
}
export async function PUT(request: Request) {
  try { guard(request); const input = await body(request); return Response.json(await changeSettings(() => saveTelegramSettings(input))); }
  catch (e) { return failure(e); }
}
