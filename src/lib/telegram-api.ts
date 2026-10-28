import type { RedisCredentials } from "./telegram-storage";
import { redactTelegram, secretsFromEnv } from "./telegram-redact";

export type TelegramButton = { text: string; data: string };

export async function telegramRequest<T>(token: string, method: string, data: object): Promise<T> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[A-Za-z]+$/.test(method)) throw new Error("Telegram 请求配置不正确");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000),
  });
  // Telegram error descriptions may echo a URL containing the Bot Token. Do not expose them.
  if (!response.ok) throw new Error("Telegram 请求失败");
  const value = await response.json() as { ok?: boolean; result: T };
  if (value.ok !== true) throw new Error("Telegram 请求失败");
  return value.result;
}

/** Telegram counts UTF-16 units; never split a surrogate pair at a message boundary. */
export function telegramChunks(text: string, limit = 4000) {
  const chunks: string[] = []; let chunk = "";
  for (const character of text || "（没有文字回复）") {
    if (chunk.length + character.length > limit) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function telegramSend(credentials: RedisCredentials, chatId: string, text: string, buttons: TelegramButton[] = []) {
  const secrets = [credentials.botToken, credentials.token, ...secretsFromEnv(process.env)];
  const chunks = telegramChunks(redactTelegram(text, secrets));
  const keyboard = buttons.slice(0, 8).map(button => {
    if (Buffer.byteLength(button.data, "utf8") > 64) throw new Error("Telegram 按钮内容过长");
    return { text: redactTelegram(button.text, secrets).slice(0, 64), callback_data: button.data };
  });
  for (let index = 0; index < chunks.length; index++) {
    await telegramRequest(credentials.botToken, "sendMessage", {
      chat_id: chatId, text: chunks[index],
      ...(keyboard.length && index === chunks.length - 1 ? { reply_markup: { inline_keyboard: [keyboard] } } : {}),
    });
  }
}
