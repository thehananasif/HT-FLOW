import { useSyncExternalStore } from 'react';
import { backend } from '../backend';
import { useSession } from '../state/session';

const stores = new Map<string, Persisted<unknown>>();
let savedHook: ((key: string) => void) | null = null;

/** Called after any store wrote its value (the window bus tells the other OS windows). */
export function setPersistedSaveHook(fn: ((key: string) => void) | null): void {
  savedHook = fn;
}

/** Re-reads a store from the profile (another OS window saved it). Unknown keys are ignored. */
export function reloadPersisted(key: string): void {
  stores.get(key)?.reload();
}

/**
 * Small external store persisted per profile through backend.saveSettings. Loads automatically
 * when a profile logs in (and again when it changes); writes are debounced.
 */
export class Persisted<T> {
  private value: T;
  private listeners = new Set<() => void>();
  private profile: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadedHooks: (() => void)[] = [];
  loaded = false;

  constructor(
    private key: string,
    private initial: () => T,
    private normalize: (raw: unknown) => T,
  ) {
    this.value = initial();
    stores.set(key, this as Persisted<unknown>);
    useSession.subscribe((s) => void this.load(s.session?.profileId ?? null));
    void this.load(useSession.getState().session?.profileId ?? null);
  }

  get(): T {
    return this.value;
  }

  set(next: T, persist = true): void {
    this.value = next;
    this.listeners.forEach((l) => l());
    if (persist && this.loaded) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.write();
      }, 300);
    }
  }

  private async write(): Promise<void> {
    try {
      await backend.saveSettings(this.key, this.value);
      savedHook?.(this.key);
    } catch {
      /* best effort, like before */
    }
  }

  /** Writes a pending (debounced) change right away. */
  async flush(): Promise<void> {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.write();
  }

  /** Reads the value again from the current profile (it was changed by another OS window). */
  reload(): void {
    if (this.timer) return; // a local change is about to be written; it wins
    const pid = this.profile;
    this.profile = null;
    void this.load(pid);
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Runs after every profile load (and now, if already loaded). */
  onLoaded(fn: () => void): void {
    this.loadedHooks.push(fn);
    if (this.loaded) fn();
  }

  private async load(pid: string | null): Promise<void> {
    if (!pid || pid === this.profile) return;
    this.profile = pid;
    this.loaded = false;
    let raw: unknown = null;
    try {
      raw = await backend.loadSettings<unknown>(this.key);
    } catch {
      raw = null;
    }
    if (this.profile !== pid) return;
    let v: T;
    try {
      v = raw === null || raw === undefined ? this.initial() : this.normalize(raw);
    } catch {
      v = this.initial();
    }
    this.loaded = true;
    this.set(v, false);
    for (const h of this.loadedHooks) h();
  }
}

export function usePersisted<T>(s: Persisted<T>): T {
  return useSyncExternalStore(s.subscribe, () => s.get());
}
