import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../backend';

/** Typed results of the Rust `feed_fetch` / `calendar_fetch` commands (see feed_cmds.rs). */
export interface NativeFeedResult {
  title: string;
  items: unknown[];
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  error?: string | null;
}
export interface NativeCalendarResult {
  events: unknown[];
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  error?: string | null;
  sourceUrl: string;
}
export interface NativeAllowList {
  defaults: string[];
  custom: string[];
  calendarHost: string;
  calendarUrl: string;
}

type Mock = Record<string, (args: Record<string, unknown>) => unknown>;

/** Test hook: Playwright installs `window.__htflowNative` to stand in for the Rust commands. */
function mock(): Mock | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __htflowNative?: Mock }).__htflowNative;
}

export function nativeAvailable(): boolean {
  return isTauri || !!mock();
}

function message(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const m = mock();
  try {
    if (!isTauri && m?.[cmd]) return (await m[cmd]!(args)) as T;
    if (!isTauri) throw new Error('Native networking is only available in the desktop app');
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(message(e));
  }
}

export const nativeFeedFetch = (url: string, force = false) =>
  call<NativeFeedResult>('feed_fetch', { url, force });
export const nativeFeedAllowAdd = (url: string) => call<string>('feed_allow_add', { url });
export const nativeFeedAllowRemove = (host: string) => call<void>('feed_allow_remove', { host });
export const nativeFeedAllowList = () => call<NativeAllowList>('feed_allow_list');
export const nativeCalendarFetch = (force = false) =>
  call<NativeCalendarResult>('calendar_fetch', { force });
