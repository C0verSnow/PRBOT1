import { guard, failure } from "@/lib/http";
import { getChat } from "@/lib/store";
import { stop } from "@/lib/runner";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    guard(request); const { id } = await context.params;
    await getChat(id); stop(id); return Response.json({ stopping: true });
  } catch (e) { return failure(e); }
}
