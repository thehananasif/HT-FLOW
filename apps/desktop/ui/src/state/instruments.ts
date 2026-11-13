import { create } from 'zustand';
import { MOCK_INSTRUMENTS, type Instrument } from '@htflow/market-data';
import {
  catalog,
  EMPTY_PREFS,
  matchFeedInstrument,
  pushRecent,
  sanitizePrefs,
  toggleFavourite,
  type CatalogInstrument,
  type CatalogPrefs,
} from '@htflow/market-catalog';
import { feedProviders } from '../feeds/registry';
import { backend, isTauri } from '../backend';

/** Free, built-in crypto venues streamed by the Rust connectors (desktop app only). */
const BINANCE_FUTURES: [string, number, number, number][] = [
  ['BTCUSDT', 0.1, 1, 3],
  ['ETHUSDT', 0.01, 2, 3],
  ['SOLUSDT', 0.01, 2, 0],
  ['BNBUSDT', 0.01, 2, 2],
  ['XRPUSDT', 0.0001, 4, 1],
  ['DOGEUSDT', 0.00001, 5, 0],
];

export const LIVE_INSTRUMENTS: Instrument[] = BINANCE_FUTURES.map(
  ([symbol, tickSize, pricePrecision, qtyPrecision]) => ({
    id: `binance-futures:${symbol}`,
    symbol,
    displayName: `${symbol} Perpetual`,
    exchange: 'Binance Futures',
    assetClass: 'crypto',
    tickSize,
    pricePrecision,
    qtyPrecision,
    tickValue: 0,
    currency: 'USDT',
  }),
);

/** How an instrument's data reaches the app (picker / watchlist "Status" column). */
export type FeedKind = 'live' | 'sim' | 'delayed' | 'replay' | 'none';

export interface FeedRef {
  id: string;
  kind: FeedKind;
  /** Source label, e.g. "HT Sim", "Binance Futures", "Replay". */
  label: string;
  instrument: Instrument;
}

/** Every instrument that can be opened right now (has a FeedSource), with its feed kind. */
function feedRefs(includeLive: boolean): FeedRef[] {
  const out: FeedRef[] = MOCK_INSTRUMENTS.map((m) => ({
    id: m.instrument.id,
    kind: 'sim' as const,
    label: m.instrument.assetClass === 'crypto' ? 'Crypto Sim' : 'HT Sim',
    instrument: m.instrument,
  }));
  if (includeLive)
    for (const i of LIVE_INSTRUMENTS)
      out.push({ id: i.id, kind: 'live', label: 'Binance Futures', instrument: i });
  for (const p of feedProviders()) {
    if (p.desktopOnly && !includeLive) continue;
    const kind: FeedKind =
      p.prefix.startsWith('replay') || p.prefix === 'csv:'
        ? 'replay'
        : /delay|dxfeed/i.test(p.label + p.prefix)
          ? 'delayed'
          : 'live';
    for (const i of p.instruments()) out.push({ id: i.id, kind, label: p.label, instrument: i });
  }
  return out;
}

const KIND_RANK: Record<FeedKind, number> = { live: 0, delayed: 1, sim: 2, replay: 3, none: 4 };

/** Catalog entry a feed instrument belongs to (cached per id). */
const matchCache = new Map<string, CatalogInstrument | null>();
function catalogFor(ref: FeedRef): CatalogInstrument | undefined {
  let c = matchCache.get(ref.id);
  if (c === undefined) {
    c = matchFeedInstrument(catalog(), ref.instrument, ref.label) ?? null;
    matchCache.set(ref.id, c);
  }
  return c ?? undefined;
}

/**
 * Openable instruments (built-in Sim, Binance live on desktop, every registered feed provider),
 * with the catalog name folded into `displayName` so the Command Palette finds "crude" → CLZ6.
 */
export function allInstruments(includeLive: boolean): Instrument[] {
  return feedRefs(includeLive).map((r) => {
    const c = catalogFor(r);
    return c && !r.instrument.displayName.includes(c.name)
      ? { ...r.instrument, displayName: `${c.name} · ${r.instrument.displayName}` }
      : r.instrument;
  });
}

/** Market-data view of a catalog entry (for display only — it has no feed by itself). */
export function catalogInstrument(c: CatalogInstrument): Instrument {
  return {
    id: c.id,
    symbol: c.symbol,
    displayName: c.name,
    exchange: c.exchange,
    assetClass:
      c.assetClass === 'crypto' ? 'crypto' : c.assetClass === 'stock' ? 'stock' : 'future',
    tickSize: c.tickSize,
    pricePrecision: c.pricePrecision,
    qtyPrecision: Math.max(0, -Math.floor(Math.log10(c.lotStep) + 1e-9)),
    tickValue: c.tickValue,
    currency: c.currency,
  };
}

/** Feed instruments by id first (mock:*, binance-futures:*, providers), then catalog ids (cat:*). */
export function instrumentById(id: string): Instrument | undefined {
  const r = feedRefs(true).find((x) => x.id === id);
  if (r) return r.instrument;
  const c = catalog().get(id);
  return c ? catalogInstrument(c) : undefined;
}

export const DEFAULT_INSTRUMENT = 'mock:CLZ6';

// ------------------------------------------------------------------ picker entries

export interface PickerEntry {
  /** Catalog id, or the feed id for feed instruments the catalog does not know. */
  key: string;
  symbol: string;
  name: string;
  exchange: string;
  tickSize: number;
  group: string;
  subGroup: string;
  catalog?: CatalogInstrument;
  /** Openable feeds, best first (live > delayed > sim > replay). */
  feeds: FeedRef[];
  status: FeedKind;
  /** Has a provider that only runs inside the Windows app (shown "Desktop app" in a browser). */
  desktopOnly: boolean;
}

export const CONNECTED_GROUP = 'Connected feeds';

/** Catalog + feed availability. A catalog future without any feed has status 'none' ("No feed — connect"). */
export function pickerEntries(includeLive = isTauri): PickerEntry[] {
  const refs = feedRefs(includeLive);
  const byCat = new Map<string, FeedRef[]>();
  const extra: PickerEntry[] = [];
  for (const r of refs) {
    const c = catalogFor(r);
    if (c) {
      const l = byCat.get(c.id) ?? [];
      l.push(r);
      byCat.set(c.id, l);
    } else {
      extra.push({
        key: r.id,
        symbol: r.instrument.symbol,
        name: r.instrument.displayName,
        exchange: r.instrument.exchange,
        tickSize: r.instrument.tickSize,
        group: CONNECTED_GROUP,
        subGroup: r.label,
        feeds: [r],
        status: r.kind,
        desktopOnly: false,
      });
    }
  }
  const entries = catalog().instruments.map((c): PickerEntry => {
    const feeds = (byCat.get(c.id) ?? []).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    return {
      key: c.id,
      symbol: c.symbol,
      name: c.name,
      exchange: c.exchange,
      tickSize: c.tickSize,
      group: c.group,
      subGroup: c.subGroup,
      catalog: c,
      feeds,
      status: feeds[0]?.kind ?? 'none',
      desktopOnly: !isTauri && c.providers.some((p) => p.provider === 'binance-futures'),
    };
  });
  return [...entries, ...extra];
}

/** Entry for a stored id (catalog id or feed id). */
export function pickerEntryFor(id: string, entries = pickerEntries()): PickerEntry | undefined {
  return entries.find((e) => e.key === id || e.feeds.some((f) => f.id === id));
}

/** The feed id to stream for a stored id, or null when nothing can serve it. */
export function feedIdFor(id: string, entries = pickerEntries()): string | null {
  if (feedRefs(isTauri).some((r) => r.id === id)) return id;
  return pickerEntryFor(id, entries)?.feeds[0]?.id ?? null;
}

// ------------------------------------------------------------------ favourites + recent

const PREFS_KEY = 'catalog.prefs';

interface PrefsState extends CatalogPrefs {
  loaded: boolean;
  toggleFavourite(id: string): void;
  pushRecent(id: string): void;
}

/** Picker favourites / recent, persisted per profile (backend settings, encrypted). */
export const usePickerPrefs = create<PrefsState>((set, get) => {
  const save = () => {
    const { favourites, recent } = get();
    void backend.saveSettings(PREFS_KEY, { favourites, recent }).catch(() => undefined);
  };
  return {
    ...EMPTY_PREFS,
    loaded: false,
    toggleFavourite: (id) => {
      set(toggleFavourite(get(), id));
      save();
    },
    pushRecent: (id) => {
      set(pushRecent(get(), id));
      save();
    },
  };
});

export function loadPickerPrefs(): void {
  if (usePickerPrefs.getState().loaded) return;
  usePickerPrefs.setState({ loaded: true });
  void backend
    .loadSettings<CatalogPrefs>(PREFS_KEY)
    .then((p) => usePickerPrefs.setState(sanitizePrefs(p)))
    .catch(() => undefined);
}
