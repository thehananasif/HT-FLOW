import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { Instrument } from '@htflow/market-data';
import {
  catalogVersion,
  discoveredCurrency,
  discoveredSuffix,
  familyOf,
  onCatalogChange,
  reportInstruments,
  setDiscoveredInstruments,
  STREAMING_VENUES,
  type DiscoveredInstrument,
  type DiscoveryReport,
} from '@htflow/market-catalog';
import { isTauri } from '../backend';
import { isVenueEnabled, onVenueChange } from './liveFeed';

/**
 * Live symbol discovery (P04/P05). The desktop core lists every tradable instrument of every
 * crypto venue (src-tauri/instruments_cmds.rs, 24 h disk cache). On start the cached list loads
 * at once, then every enabled venue whose list is missing, failed or older than 24 h is
 * downloaded in the background (failed venues are retried with a backoff, and every 6 h the
 * list is checked again); the result is merged into the market
 * catalog (picker, watchlist, palette) and into the live venues' feed instruments, so any symbol
 * opens with its real tick size and precisions. The browser preview cannot reach the venues
 * (no CORS) and keeps the seed list; tests inject a report through `window.__HTFLOW_DISCOVERY__`.
 */

declare global {
  interface Window {
    /** Test / preview hook: a discovery report the web build uses instead of the native core. */
    __HTFLOW_DISCOVERY__?: DiscoveryReport;
  }
}

interface DiscoveryState {
  report: DiscoveryReport | null;
  loading: boolean;
  error: string | null;
}

export const useDiscovery = create<DiscoveryState>(() => ({
  report: null,
  loading: false,
  error: null,
}));

async function call(cmd: string, args?: Record<string, unknown>): Promise<DiscoveryReport> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DiscoveryReport>(cmd, args);
}

/** Feed instrument of a discovered row (streamable venues only). */
export function feedInstrumentOf(d: DiscoveredInstrument): Instrument {
  return {
    id: `${d.venue}:${d.symbol}`,
    symbol: d.symbol,
    displayName: `${d.symbol} ${discoveredSuffix(d)}`,
    exchange: familyOf(d).exchange,
    assetClass: 'crypto',
    tickSize: d.tickSize,
    pricePrecision: d.pricePrecision,
    qtyPrecision: d.qtyPrecision,
    tickValue: 0,
    currency: discoveredCurrency(d),
  };
}

let byVenue = new Map<string, Instrument[]>();
let extrasCache: { version: number; list: Instrument[] } | null = null;
/** Built-in rows of each live venue (feeds/*.ts), so discovered rows only add what is new. */
const builtIn = new Map<string, Set<string>>();
let version = 0;
const memo = new Map<string, { version: number; list: Instrument[] }>();

export function registerBuiltInFeeds(venue: string, list: readonly Instrument[]): void {
  builtIn.set(venue, new Set(list.map((i) => i.id)));
}

/**
 * A live venue's feed instruments: its built-in rows (specs updated from the discovery) plus
 * every discovered symbol of the venue.
 */
export function withDiscovered(venue: string, base: readonly Instrument[]): Instrument[] {
  const m = memo.get(venue);
  if (m && m.version === version) return m.list;
  const found = byVenue.get(venue) ?? [];
  const byId = new Map(found.map((i) => [i.id, i]));
  const list = base.map((b) => {
    const f = byId.get(b.id);
    return f
      ? {
          ...b,
          tickSize: f.tickSize,
          pricePrecision: f.pricePrecision,
          qtyPrecision: f.qtyPrecision,
        }
      : b;
  });
  const have = new Set(base.map((b) => b.id));
  for (const f of found) if (!have.has(f.id)) list.push(f);
  memo.set(venue, { version, list });
  return list;
}

/** Discovered feed instrument by id (any streamable venue). */
export function discoveredFeed(id: string): Instrument | undefined {
  const venue = id.slice(0, id.indexOf(':'));
  return byVenue.get(venue)?.find((i) => i.id === id);
}

/** Discovered feed instruments that no built-in venue row covers (palette commands). */
export function discoveredExtras(): Instrument[] {
  if (extrasCache?.version === version) return extrasCache.list;
  const list: Instrument[] = [];
  for (const [venue, l] of byVenue) {
    const b = builtIn.get(venue);
    for (const i of l) if (!b?.has(i.id)) list.push(i);
  }
  extrasCache = { version, list };
  return list;
}

const feedListeners = new Set<() => void>();
export function onDiscoveryApplied(fn: () => void): () => void {
  feedListeners.add(fn);
  return () => feedListeners.delete(fn);
}

/** Applies a report: catalog merge + per-venue feed instruments. */
export function applyDiscovery(report: DiscoveryReport | null): void {
  const all = reportInstruments(report);
  const next = new Map<string, Instrument[]>();
  for (const d of all) {
    if (!STREAMING_VENUES.has(d.venue) || !(d.tickSize > 0)) continue;
    const l = next.get(d.venue) ?? [];
    l.push(feedInstrumentOf(d));
    next.set(d.venue, l);
  }
  byVenue = next;
  version++;
  useDiscovery.setState({ report });
  setDiscoveredInstruments(all);
  feedListeners.forEach((l) => l());
}

/** Per-source rows for the Data manager / Connections (count, last refresh, error). */
export function discoverySummary(r: DiscoveryReport | null) {
  return (r?.sources ?? []).map((s) => ({
    id: s.id,
    label: s.label,
    ok: s.ok,
    error: s.error,
    count: s.count,
    optionsCount: s.optionsCount,
    fetchedAtMs: s.fetchedAtMs,
  }));
}

/** Discovery source ids (src-tauri/instruments_cmds.rs SOURCES), in display order. */
export const DISCOVERY_SOURCES = [
  'binance-futures',
  'binance-coinm',
  'binance-spot',
  'bybit-linear',
  'bybit-inverse',
  'bybit-spot',
  'okx-swap',
  'okx-futures',
  'okx-spot',
  'deribit',
  'bitget',
  'kraken-futures',
  'bitfinex',
  'phemex',
  'whitebit',
] as const;

/** Sources of the venues enabled in Connections (a disabled venue is not downloaded). */
export function enabledSources(enabled: (venue: string) => boolean = isVenueEnabled): string[] {
  return DISCOVERY_SOURCES.filter((id) => enabled(id));
}

function errText(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
}

/**
 * Re-downloads symbol lists (desktop) — the "Refresh symbol list" command, or one venue's
 * "Retry". `venue` is a source id ("binance-spot") or a venue prefix ("binance").
 */
export async function refreshSymbolLists(venue?: string): Promise<DiscoveryReport | null> {
  if (!isTauri) {
    const mock = typeof window !== 'undefined' ? window.__HTFLOW_DISCOVERY__ : undefined;
    if (mock) applyDiscovery({ ...mock, refreshedAtMs: Date.now(), stale: false });
    return useDiscovery.getState().report;
  }
  return fetchLists({
    venue: venue ?? null,
    sources: venue ? null : enabledSources(),
    refresh: true,
  });
}

async function fetchLists(args: Record<string, unknown>): Promise<DiscoveryReport | null> {
  useDiscovery.setState({ loading: true, error: null });
  try {
    const r = await call('instruments_list', args);
    applyDiscovery(r);
    useDiscovery.setState({ loading: false });
    return r;
  } catch (e) {
    useDiscovery.setState({ loading: false, error: errText(e) });
    return null;
  }
}

/** Backoff (ms) before failed venues are retried automatically. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
/** The list is checked again this often while the app runs (only due sources download). */
export const RECHECK_MS = 6 * 3_600_000;

/** Failed sources of a report among `wanted`. */
export function failedSources(r: DiscoveryReport | null, wanted: readonly string[]): string[] {
  const set = new Set(wanted);
  return (r?.sources ?? []).filter((s) => !s.ok && set.has(s.id)).map((s) => s.id);
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Downloads what is due (missing / failed / stale) for the enabled venues; retries failures. */
async function syncDue(attempt = 0): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const wanted = enabledSources();
  if (!wanted.length) return;
  const r = await fetchLists({ venue: null, sources: wanted, refresh: false });
  const failed = failedSources(r, wanted);
  if ((failed.length || !r) && attempt < RETRY_DELAYS_MS.length)
    retryTimer = setTimeout(() => void syncDue(attempt + 1), RETRY_DELAYS_MS[attempt]);
}

let started = false;

/** App start: the cached list at once, then every enabled venue that is due, in the background. */
export async function startInstrumentDiscovery(): Promise<void> {
  if (started) return;
  started = true;
  if (!isTauri) {
    const mock = typeof window !== 'undefined' ? window.__HTFLOW_DISCOVERY__ : undefined;
    if (mock) applyDiscovery(mock);
    return;
  }
  try {
    const cached = await call('instruments_cached');
    if (cached.sources.length) applyDiscovery(cached);
  } catch (e) {
    useDiscovery.setState({ error: errText(e) });
  }
  await syncDue();
  setInterval(() => void syncDue(), RECHECK_MS);
  // A venue switched back on in Connections gets its list right away.
  onVenueChange(() => void syncDue());
}

/** Re-renders when the catalog is rebuilt (memo key for pickers / the watchlist). */
export function useCatalogVersion(): number {
  return useSyncExternalStore(onCatalogChange, catalogVersion, catalogVersion);
}
