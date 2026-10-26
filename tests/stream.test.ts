import { describe, expect, it } from "vitest";
import { consumeStream } from "../src/lib/stream";
import type { StreamEvent } from "../src/lib/types";
describe("browser streaming protocol", () => {
  it("preserves Chinese UTF-8 across single-byte chunks and a trailing line", async () => {
    const data = [{ type: "error", message: "中文消息" }, { type: "error", message: "末尾" }];
    const bytes = new TextEncoder().encode(data.map(v => JSON.stringify(v)).join("\n"));
    const events: StreamEvent[] = [];
    await consumeStream(new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } })), e => events.push(e));
    expect(events).toEqual(data);
  });
  it("surfaces HTTP errors", async () => expect(consumeStream(Response.json({ error: "正在执行" }, { status: 409 }), () => {})).rejects.toThrow("正在执行"));
  it("surfaces malformed stream instead of claiming success", async () => expect(consumeStream(new Response("oops\n"), () => {})).rejects.toThrow());
});
