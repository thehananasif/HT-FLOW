/** Thin bridge to the Rust core for the platform commands (crash reporter, updater, file open). */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../backend';

export { isTauri };

/** Calls a Tauri command; rejects with a readable message outside the desktop app. */
export async function native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('Not available in the web build');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'message' in e) throw new Error(String((e as Error).message));
    throw new Error(String(e));
  }
}

/** Subscribes to a core event; a no-op in the web build. Returns the unsubscribe function. */
export async function onNative<T>(event: string, fn: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<T>(event, (e) => fn(e.payload));
}
