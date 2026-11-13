/**
 * Remote alert delivery (P23): Telegram bot and Discord webhook. Pure helpers only — the user
 * supplies their own bot token / webhook URL (free), the UI keeps them in the encrypted vault and
 * performs the HTTP request.
 */

/** Telegram bot token, e.g. "123456789:AA…" (digits, colon, 30+ url-safe chars). */
export function isTelegramToken(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** Telegram chat id: a (negative for groups) integer, or a public "@channel" name. */
export function isTelegramChatId(id: string): boolean {
  const v = id.trim();
  return /^-?\d{3,20}$/.test(v) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v);
}

/** Discord webhook URL (https, discord.com / discordapp.com / ptb / canary, /api/webhooks/id/token). */
export function isDiscordWebhook(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const okHost = [
    'discord.com',
    'discordapp.com',
    'ptb.discord.com',
    'canary.discord.com',
  ].includes(host);
  return okHost && /^\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(u.pathname);
}

/** Telegram Bot API limit is 4096 characters; Discord content is 2000. */
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function formatAlertMessage(title: string, body: string, ts: number): string {
  const time = new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `🔔 HT Flow alert\n${title}\n${body}\n${time}`;
}

/**
 * Telegram sendMessage as a GET URL (the Bot API accepts GET with query parameters, so the
 * desktop app can use the existing GET-only native fetch command).
 */
export function telegramSendUrl(token: string, chatId: string, text: string): string {
  const q = new URLSearchParams({
    chat_id: chatId.trim(),
    text: clip(text, 4096),
    disable_web_page_preview: 'true',
  });
  return `https://api.telegram.org/bot${token.trim()}/sendMessage?${q.toString()}`;
}

/** JSON body for a Discord webhook POST (mentions disabled). */
export function discordBody(text: string): string {
  return JSON.stringify({
    content: clip(text, 2000),
    username: 'HT Flow',
    allowed_mentions: { parse: [] },
  });
}

/** Hides a secret inside an error / log line (token in Telegram URLs, webhook token). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('•••');
  return out;
}

/**
 * Sliding-window limiter for remote sends (so a burst of alerts cannot flood a chat or get the
 * bot rate-limited): at most `max` sends per `windowMs`.
 */
export class DeliveryThrottle {
  private sent: number[] = [];
  constructor(
    private max = 20,
    private windowMs = 60_000,
  ) {}

  /** True (and the send is counted) when a send is allowed at `now`. */
  take(now: number): boolean {
    this.sent = this.sent.filter((t) => now - t < this.windowMs);
    if (this.sent.length >= this.max) return false;
    this.sent.push(now);
    return true;
  }
}
