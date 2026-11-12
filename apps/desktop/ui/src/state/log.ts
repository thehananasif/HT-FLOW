/**
 * In-app log (P28 Logs window). A bounded ring buffer any module can write to with
 * `log.info('chart', 'message')`, plus capture of `console.error`, `window.onerror` and
 * unhandled promise rejections. The Logs window and Settings → Logs read it; Settings sets the
 * minimum level and buffer size through `logBuffer.configure`.
 */
import { useSyncExternalStore } from 'react';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  id: number;
  /** Epoch ms. */
  ts: number;
  level: LogLevel;
  /** Origin tag, e.g. `app`, `console`, `window`, `replay`. */
  source: string;
  message: string;
}

export interface LogFilter {
  /** Minimum level shown (inclusive). */
  minLevel?: LogLevel;
  /** Exact source, or undefined / '' for all. */
  source?: string;
  /** Case-insensitive substring over source + message. */
  query?: string;
}

export const DEFAULT_CAPACITY = 2000;

export class LogBuffer {
  private items: LogEntry[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  /** Messages below this level are dropped (Settings → Logs → level). */
  minLevel: LogLevel = 'debug';

  constructor(public capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be >= 1');
  }

  /** Applies Settings → Logs (level and in-memory buffer size). */
  configure(opts: { minLevel?: LogLevel; capacity?: number }): void {
    if (opts.minLevel) this.minLevel = opts.minLevel;
    if (opts.capacity !== undefined && Number.isInteger(opts.capacity) && opts.capacity >= 1) {
      this.capacity = opts.capacity;
      if (this.items.length > this.capacity) {
        this.items = this.items.slice(this.items.length - this.capacity);
        this.emit();
      }
    }
  }

  add(level: LogLevel, source: string, message: string, ts = Date.now()): LogEntry | null {
    if (RANK[level] < RANK[this.minLevel]) return null;
    const e: LogEntry = { id: ++this.seq, ts, level, source: source.trim() || 'app', message };
    const next = [...this.items, e];
    // Copy-on-write so snapshot() identity changes with content (React external-store safe).
    this.items = next.length > this.capacity ? next.slice(next.length - this.capacity) : next;
    this.emit();
    return e;
  }

  /** Oldest first. A new array on every change, so it can be used as a React snapshot. */
  snapshot(): LogEntry[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.emit();
  }

  sources(): string[] {
    return [...new Set(this.items.map((e) => e.source))].sort();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export function filterEntries(entries: readonly LogEntry[], f: LogFilter): LogEntry[] {
  const min = RANK[f.minLevel ?? 'debug'];
  const q = f.query?.trim().toLowerCase();
  return entries.filter(
    (e) =>
      RANK[e.level] >= min &&
      (!f.source || e.source === f.source) &&
      (!q || e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)),
  );
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2026-01-05 14:30:01.123` in local time. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatEntry(e: LogEntry): string {
  return `${formatTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`;
}

export function entriesToText(entries: readonly LogEntry[]): string {
  return entries.map(formatEntry).join('\n') + (entries.length ? '\n' : '');
}

/** Turns console / error arguments into one readable line. */
export function stringifyArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export const logBuffer = new LogBuffer();

/** True when a message of `level` is recorded under the configured `threshold`. */
export function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

export function clearLog(): void {
  logBuffer.clear();
}

/** Plain-text export of the buffer (or of `entries`). */
export function logText(entries: readonly LogEntry[] = logBuffer.snapshot()): string {
  return entriesToText(entries);
}

/** React hook over the shared buffer, selector style: `useLogStore((s) => s.entries)`. */
export function useLogStore<T>(select: (s: { entries: LogEntry[] }) => T): T {
  const entries = useSyncExternalStore(
    (fn) => logBuffer.subscribe(fn),
    () => logBuffer.snapshot(),
  );
  return select({ entries });
}

export const log = {
  debug: (source: string, message: string) => logBuffer.add('debug', source, message),
  info: (source: string, message: string) => logBuffer.add('info', source, message),
  warn: (source: string, message: string) => logBuffer.add('warn', source, message),
  error: (source: string, message: string) => logBuffer.add('error', source, message),
};

let installed: (() => void) | null = null;

/** Hooks console.error, window 'error' and 'unhandledrejection' into the buffer. Idempotent. */
export function installLogCapture(target: LogBuffer = logBuffer): () => void {
  if (installed) return installed;
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    try {
      target.add('error', 'console', stringifyArgs(args));
    } catch {
      /* never break console */
    }
    origError.apply(console, args);
  };
  const onError = (e: ErrorEvent) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    target.add('error', 'window', `${e.error ? stringifyArgs([e.error]) : e.message}${where}`);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    target.add('error', 'promise', `Unhandled rejection: ${stringifyArgs([e.reason])}`);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  target.add('info', 'app', 'Log capture started');
  installed = () => {
    console.error = origError;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = null;
  };
  return installed;
}
