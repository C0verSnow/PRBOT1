import type { TelegramSettings } from "./telegram-settings";
import type { RedisCredentials } from "./telegram-storage";

// Universal Auth and v4 secret API: https://infisical.com/docs/api-reference
export async function telegramCredentials(settings: TelegramSettings): Promise<RedisCredentials> {
  const login = await fetch("https://app.infisical.com/api/v1/auth/universal-auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: settings.clientId, clientSecret: settings.clientSecret }), signal: AbortSignal.timeout(15000),
  });
  if (!login.ok) throw new Error("Infisical 登录失败，请检查客户端凭据");
  const auth = await login.json() as { accessToken?: string };
  if (!auth.accessToken) throw new Error("Infisical 登录响应不正确");
  async function secret(name: string) {
    const query = new URLSearchParams({ projectId: settings.projectId, environment: settings.environment, secretPath: "/" });
    const response = await fetch(`https://app.infisical.com/api/v4/secrets/${name}?${query}`, { headers: { Authorization: `Bearer ${auth.accessToken}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Infisical 无法读取 ${name}`);
    const result = await response.json() as { secret?: { secretValue?: unknown } };
    if (typeof result.secret?.secretValue !== "string" || !result.secret.secretValue) throw new Error(`Infisical 的 ${name} 为空`);
    return result.secret.secretValue;
  }
  const [botToken, url, token] = await Promise.all([secret("TELEGRAM_BOT_TOKEN"), secret("UPSTASH_REDIS_REST_URL"), secret("UPSTASH_REDIS_REST_TOKEN")]);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Upstash 地址格式不正确"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || !parsed.hostname.endsWith(".upstash.io")) throw new Error("Upstash 地址必须是官方 HTTPS REST 地址");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Telegram Bot Token 格式不正确");
  return { botToken, url: parsed.toString(), token };
}
