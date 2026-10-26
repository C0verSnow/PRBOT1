import { discoverModels } from "@/lib/models";
import { guard, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json({ models: await discoverModels() }); } catch (e) { return failure(e); }
}
