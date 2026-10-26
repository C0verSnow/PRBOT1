export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
// Local-only API: reject DNS rebinding and browser requests from other websites.
export function guard(request: Request) {
  const host = request.headers.get("host");
  if (!host) throw new HttpError(403, "仅允许本机访问");
  let url: URL;
  try { url = new URL(`http://${host}`); } catch { throw new HttpError(403, "无效地址"); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new HttpError(403, "仅允许本机访问");
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "不接受其他网页发来的操作");
}
export function failure(error: unknown) {
  const known = error instanceof HttpError;
  if (!known) console.error("PRBOT request failed:", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: known ? error.message : "操作失败，请检查项目路径、登录状态和本机日志。" }, { status: known ? error.status : 500 });
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请发送 JSON 内容");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new HttpError(413, "消息太长，请分几次发送"); }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "JSON 内容格式不正确");
  } finally { reader.releaseLock(); }
}
