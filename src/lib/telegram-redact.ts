const HIDDEN = "[已隐藏密钥]";

/** Values from the process/project environment must never reach disk, Redis or Telegram. */
export function secretsFromEnv(env: Record<string, string | undefined>) {
  return Object.entries(env)
    .filter(([key, value]) => value && /(?:key|secret|token|password|passwd|credential|authorization|cookie)/i.test(key))
    .map(([, value]) => value!);
}

export function redactTelegram(text: string, secrets: readonly string[] = []) {
  let value = text;
  // Longest first prevents a short credential prefix exposing the remainder of a longer one.
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    // Punctuation-only configuration values (notably / and \) are not useful
    // literal credentials. Short alphanumeric values need token boundaries.
    if (!/[\p{L}\p{N}]/u.test(secret)) continue;
    for (const candidate of new Set([secret, encodeURIComponent(secret)])) {
      if (secret.length >= 8) value = value.split(candidate).join(HIDDEN);
      else {
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        value = value.replace(new RegExp(`(?<![\\p{L}\\p{N}_/\\\\.-])${escaped}(?![\\p{L}\\p{N}_/\\\\.-])`, "gu"), HIDDEN);
      }
    }
  }
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, HIDDEN)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, HIDDEN)
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, `bot${HIDDEN}`)
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, HIDDEN)
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, `$1 ${HIDDEN}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`)
    .replace(/([?&](?:token|key|api_key|apikey|secret|password|access_token|auth)=)[^&#\s"']+/gi, `$1${HIDDEN}`)
    .replace(/((?:["']?[A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE)[A-Za-z0-9_]*["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}&#]+)/gi, `$1${HIDDEN}`);
}
