import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "../src/lib/drafts";
afterEach(() => vi.unstubAllGlobals());
describe("browser draft persistence", () => {
  it("separates new and existing conversations and clears sent drafts", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
    expect(writeDraft(null, "新任务")).toBe(true); writeDraft("chat-1", "继续任务");
    expect(readDraft(null)).toBe("新任务"); expect(readDraft("chat-1")).toBe("继续任务");
    writeDraft("chat-1", ""); expect(readDraft("chat-1")).toBe(""); expect(readDraft(null)).toBe("新任务");
  });
  it("does not break the composer when storage is denied", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } });
    expect(readDraft(null)).toBe(""); expect(writeDraft(null, "仍可发送")).toBe(false);
  });
});
