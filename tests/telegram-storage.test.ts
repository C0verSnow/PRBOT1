import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { APPEND } from "../src/lib/telegram-storage";

// CI runs these assertions against Redis, not a mock of the eviction script.
const redis = (...args: string[]) => execFileSync("redis-cli", ["--raw", ...args], { encoding: "utf8" }).trim();
describe.skipIf(process.env.PRBOT_TEST_REDIS !== "1")("Telegram rolling storage", () => {
  it("counts UTF-8 bytes and atomically evicts the oldest entries", () => {
    const list = `prbot:test:${process.pid}:list`; const size = `${list}:size`;
    try {
      redis("DEL", list, size);
      const append = (value: string) => redis("EVAL", APPEND, "2", list, size, value, "8");
      expect(append("abc")).toBe("3");
      expect(append("中文")).toBe("6");
      expect(redis("LRANGE", list, "0", "-1")).toBe("中文");
      expect(append("ok")).toBe("8");
      expect(redis("LRANGE", list, "0", "-1")).toBe("ok\n中文");
      expect(append("123456789")).toBe("-1");
      expect(redis("GET", size)).toBe("8");
    } finally { redis("DEL", list, size); }
  });
});
