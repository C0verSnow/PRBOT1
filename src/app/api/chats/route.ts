import { createChat, listChats } from "@/lib/store";
import { guard, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json(await listChats()); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try { guard(request); return Response.json(await createChat(), { status: 201 }); } catch (e) { return failure(e); }
}
