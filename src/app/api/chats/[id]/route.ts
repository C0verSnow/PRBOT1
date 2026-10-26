import { getChat, deleteChat } from "@/lib/store";
import { recover, reserve, liveChat } from "@/lib/runner";
import { guard, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { guard(request); const { id } = await context.params; return Response.json(liveChat(id) ?? recover(await getChat(id))); } catch (e) { return failure(e); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    guard(request);
    const { id } = await context.params;
    const lock = reserve(id);
    try { await deleteChat(id); return new Response(null, { status: 204 }); } finally { lock.release(); }
  } catch (e) { return failure(e); }
}
