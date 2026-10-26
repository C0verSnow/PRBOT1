import { publicConfig } from "@/lib/config";
import { guard, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json(await publicConfig()); } catch (e) { return failure(e); }
}
