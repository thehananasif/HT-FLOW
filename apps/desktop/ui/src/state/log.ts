/**
 * Application log (Settings → Logs). A bounded in-memory ring buffer that honours the configured
 * level; the Logs window (P28) and the Settings → Logs page read it. File output and retention
 * (`logs.keepDays`, `logs.folder`) arrive with the native core.
 */
import { create } from 'zustand';
import { getSetting } from './settings';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export interface LogEntry {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

/** True when a message of `level` is recorded under the configured `threshold`. */
export function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(threshold);
}

interface LogStore {
  entries: LogEntry[];
}

export const useLogStore = create<LogStore>(() => ({ entries: [] }));

export function log(level: LogLevel, source: string, message: string): void {
  if (!levelEnabled(level, getSetting('logs.level') as LogLevel)) return;
  const cap = getSetting('logs.bufferSize');
  useLogStore.setState((s) => {
    const entries = [...s.entries, { ts: Date.now(), level, source, message }];
    return { entries: entries.length > cap ? entries.slice(entries.length - cap) : entries };
  });
}

export function clearLog(): void {
  useLogStore.setState({ entries: [] });
}

/** Plain-text export of the buffer (one line per entry, ISO timestamps). */
export function logText(entries: LogEntry[] = useLogStore.getState().entries): string {
  return entries
    .map(
      (e) =>
        `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`,
    )
    .join('\n');
}

let installed = false;

/** Records uncaught errors and console warnings / errors. Idempotent. */
export function installLogCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => log('error', 'window', e.message));
  window.addEventListener('unhandledrejection', (e) =>
    log('error', 'promise', String((e.reason as Error)?.message ?? e.reason)),
  );
  for (const level of ['warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      log(level, 'console', args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '));
    };
  }
  log('info', 'app', 'HT Flow started');
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
