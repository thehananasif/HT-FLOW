import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WindowState } from '@htflow/workspace';
import { backend, isTauri } from '../../backend';
import { useSession } from '../../state/session';
import { useWindows } from '../../state/windows';
import { runCommand } from '../../shell/commands';
import { allInstruments } from '../../state/instruments';
import { instrumentRoot } from '@htflow/info';

/**
 * Fetches a public text resource (RSS / Atom / OPML / ICS).
 * Desktop: the Rust core (`net_fetch_text`, http/https only, 15 s, 5 MB). Browser dev mode:
 * window.fetch, which most feeds block with CORS — callers fall back to cache / offline sample.
 */
export async function fetchText(url: string): Promise<string> {
  if (isTauri) {
    try {
      return await invoke<string>('net_fetch_text', { url });
    } catch (e) {
      const msg =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      throw new Error(msg);
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    throw new Error(
      e instanceof Error && e.name !== 'AbortError'
        ? `${e.message} (browser preview: blocked by CORS or offline)`
        : 'Timed out',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Opens a link: a Web Pages window may claim it via the cancelable `htflow:open-url` event. */
export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const ev = new CustomEvent('htflow:open-url', { detail: url, cancelable: true });
  if (window.dispatchEvent(ev)) window.open(url, '_blank', 'noopener,noreferrer');
}

let lastChart: string | null = null;
useWindows.subscribe((s) => {
  if (s.activeId && s.windows[s.activeId]?.kind === 'chart') lastChart = s.activeId;
});

/** Id of the active (or most recently active, or first) chart window. */
export function activeChartId(): string | null {
  const { windows, activeId } = useWindows.getState();
  if (activeId && windows[activeId]?.kind === 'chart') return activeId;
  if (lastChart && windows[lastChart]?.kind === 'chart') return lastChart;
  return Object.keys(windows).find((k) => windows[k]!.kind === 'chart') ?? null;
}

/** Instrument id matching a tag (ticker or root), preferring open/active instruments. */
export function instrumentForTag(tag: string): string | null {
  const up = tag.toUpperCase();
  const list = allInstruments(isTauri);
  const exact = list.find((i) => i.symbol.toUpperCase() === up.replace(/\.P$/, ''));
  if (exact) return exact.id;
  const root = instrumentRoot(up);
  return list.find((i) => instrumentRoot(i.symbol) === root)?.id ?? null;
}

/** Points the active chart at an instrument (opens a chart first when there is none). */
export function openChartFor(instrumentId: string): boolean {
  let id = activeChartId();
  if (!id) {
    runCommand('open.chart');
    id = activeChartId();
  }
  if (!id) return false;
  useWindows.getState().patch(id, { instrumentId } as Partial<WindowState>);
  return true;
}

/** Re-renders every `ms`. */
export function useTick(ms: number): number {
  const [n, set] = useState(0);
  useEffect(() => {
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
  return n;
}

/** Minimal external store with per-profile persistence through backend.saveSettings. */
export class PersistedStore<T> {
  private value: T;
  private listeners = new Set<() => void>();
  private profile: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  loaded = false;

  constructor(
    private key: string,
    private initial: () => T,
    private normalize: (raw: unknown) => T,
    private onLoaded?: () => void,
  ) {
    this.value = initial();
  }

  get(): T {
    return this.value;
  }

  set(next: T, persist = true): void {
    this.value = next;
    this.listeners.forEach((l) => l());
    if (persist && this.loaded) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(
        () => void backend.saveSettings(this.key, this.value).catch(() => {}),
        400,
      );
    }
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Loads the logged-in profile's state once (reloads when the profile changes). */
  async ensureLoaded(): Promise<void> {
    const pid = useSession.getState().session?.profileId ?? null;
    if (!pid || pid === this.profile) return;
    this.profile = pid;
    this.loaded = false;
    let raw: unknown = null;
    try {
      raw = await backend.loadSettings<unknown>(this.key);
    } catch {
      raw = null;
    }
    this.loaded = true;
    this.set(raw === null ? this.initial() : this.normalize(raw), false);
    this.onLoaded?.();
  }
}

export function useStore<T>(s: PersistedStore<T>): T {
  useEffect(() => void s.ensureLoaded(), [s]);
  return useSyncExternalStore(s.subscribe, () => s.get());
}

/** Triggers a browser download of text. */
export function download(name: string, text: string, type = 'application/octet-stream'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Opens a file picker and resolves with the chosen file's text. */
export function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > 20 * 1024 * 1024) return resolve(null);
      void f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

export function userTimezone(): string {
  return (
    useSession.getState().session?.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

export const fmtClock = (t: number, tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: tz,
    }).format(t);
  } catch {
    return new Date(t).toISOString().slice(11, 16);
  }
};
