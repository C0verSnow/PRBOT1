import { body, guard, failure, HttpError } from "@/lib/http";
import { prepareTurn, streamTurn } from "@/lib/runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    guard(request);
    const input = await body(request);
    if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new HttpError(400, "请输入消息");
    if (input.prompt.length > 16_000) throw new HttpError(400, "消息最多 16000 字，请分几次发送");
    const prompt = input.prompt.trim();
    const turn = await prepareTurn((await context.params).id, prompt);
    return new Response(streamTurn(turn, prompt, request.signal), {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  } catch (e) { return failure(e); }
}
