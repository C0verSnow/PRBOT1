import { describe, expect, it } from "vitest";
import { body, guard, HttpError } from "../src/lib/http";
function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/chats", { headers: { host: "localhost:3000", ...headers } });
}
describe("local API boundary", () => {
  it("accepts same-origin localhost", () => expect(() => guard(req({ origin: "http://localhost:3000" }))).not.toThrow());
  it.each(["evil.example", "localhost.evil.example", "evil.example:3000"])("rejects DNS rebinding: %s", host => expect(() => guard(req({ host }))).toThrow(HttpError));
  it.each(["https://evil.example", "null", "http://localhost:4000"])("rejects foreign origin: %s", origin => expect(() => guard(req({ origin }))).toThrow());
  it("rejects cross-site fetch", () => expect(() => guard(req({ "sec-fetch-site": "cross-site" }))).toThrow());
  it("accepts IPv6 loopback", () => expect(() => guard(req({ host: "[::1]:3000", origin: "http://[::1]:3000" }))).not.toThrow());
  it("rejects missing Host", () => expect(() => guard(new Request("http://localhost/api"))).toThrow());
});
describe("bounded JSON input", () => {
  it("reads a valid prompt", async () => expect(await body(new Request("http://localhost", { method: "POST", body: '{"prompt":"你好"}' }))).toEqual({ prompt: "你好" }));
  it.each(["[]", "null", "not-json"])("rejects malformed input %s", async data => expect(body(new Request("http://localhost", { method: "POST", body: data }))).rejects.toMatchObject({ status: 400 }));
  it("rejects oversized input without a content-length", async () => expect(body(new Request("http://localhost", { method: "POST", body: JSON.stringify({ prompt: "a".repeat(64000) }) }))).rejects.toMatchObject({ status: 413 }));
});
