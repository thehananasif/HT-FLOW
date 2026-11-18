import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../backend';
import type { CotReport } from '../charts/layers/cotMarkets';

/** One trader category of a weekly report (mirrors the Rust `CotGroup`). */
export interface CotGroup {
  key: string;
  label: string;
  long: number;
  short: number;
  spread: number;
  net: number;
  longChange: number;
  shortChange: number;
  netChange: number;
}

export interface CotRow {
  /** Report date (a Tuesday), `YYYY-MM-DD`. */
  date: string;
  openInterest: number;
  oiChange: number;
  groups: CotGroup[];
}

/** What the native `cot_fetch` command returns. */
export interface CotNativeResult {
  rows: CotRow[];
  fetchedAt: number;
  source: 'network' | 'cache' | 'stale-cache';
  warning?: string | null;
}

export interface CotFetchArgs {
  report: CotReport;
  marketCode: string;
  fromDate: string;
  force?: boolean;
  /** Serve any cached copy (even a stale one); download only when there is none. */
  cacheOnly?: boolean;
}

declare global {
  interface Window {
    /** Web build / e2e only: stands in for the native `cot_fetch` command. */
    __HTFLOW_COT_MOCK__?: (a: CotFetchArgs) => Promise<CotNativeResult>;
  }
}

/** Native call (desktop), or the injected mock (web build tests); otherwise "unavailable". */
export async function cotFetchNative(a: CotFetchArgs): Promise<CotNativeResult> {
  if (isTauri)
    return invoke<CotNativeResult>('cot_fetch', {
      report: a.report,
      marketCode: a.marketCode,
      fromDate: a.fromDate,
      force: a.force ?? false,
      cacheOnly: a.cacheOnly ?? false,
    });
  if (typeof window !== 'undefined' && window.__HTFLOW_COT_MOCK__)
    return window.__HTFLOW_COT_MOCK__(a);
  throw { code: 'cot.unavailable', message: 'COT download needs the desktop app' };
}

/** Errors that mean "no connection" (as opposed to "no data for this market"). */
export function isOfflineError(code: string | undefined): boolean {
  return (
    code === 'cot.unavailable' ||
    code === 'cot.network' ||
    code === 'cot.http' ||
    code === 'cot.client' ||
    code === 'cot.too_large'
  );
}

export type CotStatus = 'loading' | 'ready' | 'empty' | 'offline' | 'error';

export interface CotEntry {
  status: CotStatus;
  rows: CotRow[];
  fetchedAt: number;
  source?: CotNativeResult['source'];
  warning?: string;
  error?: string;
}

interface CotStore {
  entries: Record<string, CotEntry>;
  load(
    report: CotReport,
    marketCode: string,
    years: number,
    force?: boolean,
    cacheOnly?: boolean,
  ): Promise<void>;
  /** Re-downloads every entry that is on screen (Command Palette: Refresh COT data). */
  refreshAll(years: number): Promise<void>;
}

export const cotKey = (report: CotReport, marketCode: string) => `${report}:${marketCode}`;

/** First day of the year `years` back: stable across the year so the disk cache stays valid. */
export function cotFromDate(years: number, now = new Date()): string {
  return `${now.getUTCFullYear() - Math.max(1, Math.round(years))}-01-01`;
}

const inflight = new Map<string, Promise<void>>();

export const useCot = create<CotStore>((set, get) => ({
  entries: {},
  async load(report, marketCode, years, force = false, cacheOnly = false) {
    const key = cotKey(report, marketCode);
    const running = inflight.get(key);
    if (running && !force) return running;
    const prev = get().entries[key];
    set((s) => ({
      entries: {
        ...s.entries,
        [key]: { status: 'loading', rows: prev?.rows ?? [], fetchedAt: prev?.fetchedAt ?? 0 },
      },
    }));
    const p = (async () => {
      try {
        const r = await cotFetchNative({
          report,
          marketCode,
          fromDate: cotFromDate(years),
          force,
          cacheOnly,
        });
        const entry: CotEntry = {
          status: r.rows.length ? 'ready' : 'empty',
          rows: r.rows,
          fetchedAt: r.fetchedAt,
          source: r.source,
          warning: r.warning ?? undefined,
        };
        set((s) => ({ entries: { ...s.entries, [key]: entry } }));
      } catch (e) {
        const err = e as { code?: string; message?: string };
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: {
              status: isOfflineError(err.code) ? 'offline' : 'error',
              rows: [],
              fetchedAt: 0,
              error: err.message ?? 'COT download failed',
            },
          },
        }));
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  },
  async refreshAll(years) {
    const keys = Object.keys(get().entries);
    await Promise.all(
      keys.map((k) => {
        const [report, code] = k.split(':') as [CotReport, string];
        return get().load(report, code, years, true);
      }),
    );
  },
}));

/** True when the cached copy is older than the latest Friday release (20:30 UTC). */
export function isCotStale(fetchedAt: number, now = Date.now()): boolean {
  const DAY = 86_400_000;
  const day = Math.floor(now / DAY);
  const dow = (((day + 3) % 7) + 7) % 7; // Monday = 0
  const back = (((dow - 4) % 7) + 7) % 7;
  let rel = (day - back) * DAY + (20 * 60 + 30) * 60_000;
  if (rel > now) rel -= 7 * DAY;
  return fetchedAt < rel;
}
