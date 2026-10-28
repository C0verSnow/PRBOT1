import { describe, expect, it } from "vitest";
import { redactTelegram, secretsFromEnv } from "../src/lib/telegram-redact";

describe("Telegram redaction at the storage and transport boundary", () => {
  it("keeps path separators and bot commands when an environment credential is punctuation", () => {
    const text = "/Users/troy/Desktop/2 /confirm /status C:\\project\\src";
    expect(redactTelegram(text, ["/", "\\", ".", "1"])).toBe(text);
    expect(redactTelegram("PIN=abc abc alphabet", ["abc"])).toBe("PIN=[已隐藏密钥] [已隐藏密钥] alphabet");
  });
  it("removes configured secrets and their URL-encoded forms", () => {
    const secret = "private/value+with spaces";
    const value = redactTelegram(`command ${secret} ${encodeURIComponent(secret)} normal progress`, [secret]);
    expect(value).not.toContain(secret); expect(value).not.toContain(encodeURIComponent(secret));
    expect(value).toContain("normal progress"); expect(value.match(/已隐藏密钥/g)).toHaveLength(2);
  });
  it("redacts known token formats, authorization, URLs and environment assignments", () => {
    const text = [
      "OPENAI_API_KEY=some-custom-value",
      '"clientSecret": "custom value with spaces"',
      "Authorization: Bearer randomcredential",
      "https://user:password@example.com/path?access_token=query-value&other=ok",
      "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/getMe",
      "ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const value = redactTelegram(text);
    for (const secret of ["some-custom-value", "custom value with spaces", "randomcredential", "user:password", "query-value", "123456:abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz", "sk-abcdefghijklmnopqrstuvwxyz", "private-material"]) expect(value).not.toContain(secret);
    expect(value).toContain("other=ok");
  });
  it("uses environment secrets while keeping ordinary runtime values out of the list", () => {
    expect(secretsFromEnv({ CODEX_API_KEY: "openai-value", GITHUB_TOKEN: "gh-value", CLIENT_SECRET: "client-value", CODEX_HOME: "/codex", PATH: "/bin", EMPTY_TOKEN: "" })).toEqual(["openai-value", "gh-value", "client-value"]);
  });
});
