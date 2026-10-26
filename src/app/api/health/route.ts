import { guard, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    guard(request);
    // Startup identity only; this value is not an authentication credential.
    return Response.json({ ok: true, instance: process.env.PRBOT_INSTANCE_ID || null });
  } catch (e) { return failure(e); }
}
