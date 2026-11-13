/**
 * Remote alert delivery (P23): Telegram bot + Discord webhook. The user brings their own bot token
 * / webhook URL (free); both live in the encrypted profile vault, never in plain settings.
 *
 * Transport:
 * - Telegram: the Bot API accepts GET, so the desktop app uses the existing native
 *   `net_fetch_text` command (the WebView CSP blocks remote fetch). Browser build: window.fetch.
 * - Discord: webhooks need POST. The desktop app calls the native `net_post_json` command, which
 *   is NOT in the Rust core yet (see docs/BLOCKERS.md); until it lands the send fails with a
 *   clear message. Browser build: window.fetch POST.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  DeliveryThrottle,
  discordBody,
  isDiscordWebhook,
  isTelegramChatId,
  isTelegramToken,
  redactSecrets,
  telegramSendUrl,
} from '@htflow/alerts';
import { backend, isTauri } from '../../backend';

export const VAULT_KEYS = {
  telegramToken: 'alerts.telegram.token',
  telegramChat: 'alerts.telegram.chat',
  discordWebhook: 'alerts.discord.webhook',
} as const;

export interface DeliveryConfig {
  telegramToken: string;
  telegramChat: string;
  discordWebhook: string;
}

let cache: DeliveryConfig | null = null;

export async function loadDelivery(): Promise<DeliveryConfig> {
  if (cache) return cache;
  const get = async (k: string) => {
    try {
      return (await backend.vaultGet(k)) ?? '';
    } catch {
      return '';
    }
  };
  cache = {
    telegramToken: await get(VAULT_KEYS.telegramToken),
    telegramChat: await get(VAULT_KEYS.telegramChat),
    discordWebhook: await get(VAULT_KEYS.discordWebhook),
  };
  return cache;
}

/** Forget the cached secrets (log out / profile switch). */
export function clearDeliveryCache(): void {
  cache = null;
}

/** Problems with the entered settings (empty fields are allowed: that channel is off). */
export function validateDelivery(c: DeliveryConfig): string[] {
  const e: string[] = [];
  if (c.telegramToken || c.telegramChat) {
    if (!isTelegramToken(c.telegramToken)) e.push('Telegram bot token looks wrong');
    if (!isTelegramChatId(c.telegramChat)) e.push('Telegram chat id looks wrong');
  }
  if (c.discordWebhook && !isDiscordWebhook(c.discordWebhook))
    e.push('Discord webhook must be https://discord.com/api/webhooks/…');
  return e;
}

export async function saveDelivery(c: DeliveryConfig): Promise<void> {
  const next = {
    telegramToken: c.telegramToken.trim(),
    telegramChat: c.telegramChat.trim(),
    discordWebhook: c.discordWebhook.trim(),
  };
  await backend.vaultPut(VAULT_KEYS.telegramToken, next.telegramToken);
  await backend.vaultPut(VAULT_KEYS.telegramChat, next.telegramChat);
  await backend.vaultPut(VAULT_KEYS.discordWebhook, next.discordWebhook);
  cache = next;
}

export const hasTelegram = (c: DeliveryConfig) =>
  isTelegramToken(c.telegramToken) && isTelegramChatId(c.telegramChat);
export const hasDiscord = (c: DeliveryConfig) => isDiscordWebhook(c.discordWebhook);

const errText = (e: unknown) =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);

async function sendTelegram(c: DeliveryConfig, text: string): Promise<void> {
  const url = telegramSendUrl(c.telegramToken, c.telegramChat, text);
  try {
    if (isTauri) await invoke<string>('net_fetch_text', { url });
    else {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    throw new Error(`Telegram: ${redactSecrets(errText(e), [c.telegramToken])}`);
  }
}

async function sendDiscord(c: DeliveryConfig, text: string): Promise<void> {
  const body = discordBody(text);
  try {
    if (isTauri) {
      try {
        await invoke<string>('net_post_json', { url: c.discordWebhook, body });
      } catch (e) {
        const m = errText(e);
        if (/not found|unknown command|net_post_json/i.test(m))
          throw new Error('needs the native POST command (net_post_json) — see BLOCKERS');
        throw e;
      }
    } else {
      const r = await fetch(c.discordWebhook, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    throw new Error(`Discord: ${redactSecrets(errText(e), [c.discordWebhook])}`);
  }
}

const throttle = new DeliveryThrottle(20, 60_000);

export type Channel = 'telegram' | 'discord';

/**
 * Sends `text` to the chosen channels. Resolves with one error string per failed / unconfigured
 * channel (never throws). Throttled to 20 sends a minute across channels.
 */
export async function deliver(
  channels: Channel[],
  text: string,
  opts: { now?: number; ignoreThrottle?: boolean } = {},
): Promise<string[]> {
  if (!channels.length) return [];
  const c = await loadDelivery();
  const errors: string[] = [];
  for (const ch of channels) {
    if (!opts.ignoreThrottle && !throttle.take(opts.now ?? Date.now())) {
      errors.push(`${ch}: too many alerts this minute, skipped`);
      continue;
    }
    try {
      if (ch === 'telegram') {
        if (!hasTelegram(c)) throw new Error('Telegram is not set up (Alerts → Delivery)');
        await sendTelegram(c, text);
      } else {
        if (!hasDiscord(c)) throw new Error('Discord is not set up (Alerts → Delivery)');
        await sendDiscord(c, text);
      }
    } catch (e) {
      errors.push(errText(e));
    }
  }
  return errors;
}
