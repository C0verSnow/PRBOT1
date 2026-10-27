export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTelegramBot } = await import("./lib/telegram-bot");
    startTelegramBot();
  }
}
