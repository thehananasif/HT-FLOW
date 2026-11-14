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

/**
 * Live symbol discovery (P04/P05). The desktop core lists every tradable instrument of every
 * crypto venue (src-tauri/instruments_cmds.rs, 24 h disk cache). On start the cached list loads
 * at once and a stale one is refreshed in the background; the result is merged into the market
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

/** Re-downloads every venue's symbol list (desktop) — the "Refresh symbol list" command. */
export async function refreshSymbolLists(venue?: string): Promise<DiscoveryReport | null> {
  if (!isTauri) {
    const mock = typeof window !== 'undefined' ? window.__HTFLOW_DISCOVERY__ : undefined;
    if (mock) applyDiscovery({ ...mock, refreshedAtMs: Date.now(), stale: false });
    return useDiscovery.getState().report;
  }
  useDiscovery.setState({ loading: true, error: null });
  try {
    const r = await call('instruments_list', { venue: venue ?? null, refresh: true });
    applyDiscovery(r);
    useDiscovery.setState({ loading: false });
    return r;
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    useDiscovery.setState({ loading: false, error: msg });
    return null;
  }
}

let started = false;

/** App start: the cached list at once, then a background refresh when it is stale or empty. */
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
    if (cached.stale || !cached.sources.length) await refreshSymbolLists();
  } catch (e) {
    useDiscovery.setState({ error: String(e) });
  }
}

/** Re-renders when the catalog is rebuilt (memo key for pickers / the watchlist). */
export function useCatalogVersion(): number {
  return useSyncExternalStore(onCatalogChange, catalogVersion, catalogVersion);
}
