import type {
  EventBatch,
  FeedSource,
  FeedStatus,
  HistoryData,
  Instrument,
  Trade,
} from '@htflow/market-data';
import {
  DEFAULT_LAYERS,
  datasetFromHistory,
  type ReplayDataInfo,
  type ReplayDataSource,
  type ReplayDataset,
  type ReplayLayers,
} from '@htflow/replay';
import { registerFeedProvider } from './registry';
import { registerReplaySource } from './replay';

/**
 * Imported datasets (P06 CSV importer). Each import becomes a static instrument `csv:<name>`:
 * charts open it like any other feed (history only, nothing live) and Replay lists it as the
 * "Imported files" data source. Data stays on this PC: kept in memory and mirrored to IndexedDB so
 * it survives a restart.
 */
export const IMPORT_PREFIX = 'csv:';

export interface ImportedDataset {
  id: string;
  name: string;
  instrument: Instrument;
  /** Trades in time order, px in ticks. */
  trades: Trade[];
  from: number;
  to: number;
  importedAt: number;
  source: 'trades' | 'bars';
}

const datasets = new Map<string, ImportedDataset>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export const onImportedChange = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const listImported = (): ImportedDataset[] => [...datasets.values()];
export const importedById = (id: string): ImportedDataset | undefined => datasets.get(id);
export const isImportedId = (id: string) => id.startsWith(IMPORT_PREFIX);

/** Instrument-id-safe slug of a display name. */
export function slugOf(name: string): string {
  const s = name
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || 'import').slice(0, 40);
}

export interface NewImport {
  name: string;
  trades: Trade[];
  tickSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  source: 'trades' | 'bars';
}

export function addImported(n: NewImport): ImportedDataset {
  const slug = slugOf(n.name);
  const id = IMPORT_PREFIX + slug;
  const instrument: Instrument = {
    id,
    symbol: slug,
    displayName: `${n.name.trim() || slug} (CSV)`,
    exchange: 'CSV import',
    assetClass: 'crypto',
    tickSize: n.tickSize,
    pricePrecision: n.pricePrecision,
    qtyPrecision: n.qtyPrecision,
    tickValue: 0,
    currency: 'USD',
  };
  const ds: ImportedDataset = {
    id,
    name: n.name.trim() || slug,
    instrument,
    trades: n.trades,
    from: n.trades[0]?.ts ?? 0,
    to: n.trades.at(-1)?.ts ?? 0,
    importedAt: Date.now(),
    source: n.source,
  };
  datasets.set(id, ds);
  void persist(ds);
  notify();
  return ds;
}

export function removeImported(id: string): void {
  if (!datasets.delete(id)) return;
  void unpersist(id);
  notify();
}

// ------------------------------------------------------------------ replay source

const DAY = 86_400_000;

class ImportedSource implements ReplayDataSource {
  readonly id = 'csv-import';
  readonly label = 'Imported files (this PC)';

  covers(instrumentId: string): boolean {
    return (datasets.get(instrumentId)?.trades.length ?? 0) > 1;
  }

  async range(instrumentId: string): Promise<{ from: number; to: number } | null> {
    await ready;
    const d = datasets.get(instrumentId);
    return d && d.trades.length > 1 ? { from: d.from, to: d.to } : null;
  }

  async info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo> {
    await ready;
    const d = datasets.get(instrumentId);
    if (!d) return { where: 'memory', bytes: 0, days: 0, trades: 0 };
    const n = d.trades.filter((t) => t.ts >= from && t.ts <= to).length;
    return {
      where: 'memory',
      bytes: n * 48,
      days: (d.to - d.from) / DAY,
      trades: n,
      note: `Imported from ${d.source === 'bars' ? 'OHLCV bars' : 'trades'} CSV (no depth)`,
    };
  }

  async load(
    instrumentId: string,
    from: number,
    to: number,
    layers: ReplayLayers = DEFAULT_LAYERS,
  ): Promise<ReplayDataset> {
    await ready;
    const d = datasets.get(instrumentId);
    if (!d) throw new Error(`No imported data for ${instrumentId}`);
    return datasetFromHistory(
      { instrument: d.instrument, trades: d.trades, depth: [] },
      from,
      to,
      layers,
    );
  }
}

registerReplaySource(new ImportedSource(), false);

// ------------------------------------------------------------------ chart feed

class ImportedFeed implements FeedSource {
  readonly kind = 'replay' as const;
  readonly capabilities = { aggressor: true, ticks: true, subSecond: true };
  private fallback: Instrument;

  constructor(readonly id: string) {
    const name = id.slice(IMPORT_PREFIX.length);
    this.fallback = {
      id,
      symbol: name,
      displayName: `${name} (CSV)`,
      exchange: 'CSV import',
      assetClass: 'crypto',
      tickSize: 0.01,
      pricePrecision: 2,
      qtyPrecision: 0,
      tickValue: 0,
      currency: 'USD',
    };
  }

  /** The stored instrument once restored from disk; a placeholder until then. */
  get instrument(): Instrument {
    return datasets.get(this.id)?.instrument ?? this.fallback;
  }

  async history(): Promise<HistoryData> {
    await ready;
    const d = datasets.get(this.id);
    if (!d)
      throw new Error(`Imported data ${this.id} is no longer on this PC. Import the file again.`);
    return {
      trades: d.trades.slice(),
      depth: [],
      book: { ts: d.to, bids: [], asks: [] },
      end: d.to,
    };
  }

  subscribe(_listener: (b: EventBatch) => void): () => void {
    return () => undefined;
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    const n = datasets.get(this.id)?.trades.length ?? 0;
    listener({
      state: 'replay',
      latencyMs: 0,
      msgsPerSec: 0,
      message: `Imported file · ${n.toLocaleString()} trades · static`,
    });
    return () => undefined;
  }

  start(): void {}
  stop(): void {}
}

registerFeedProvider({
  prefix: IMPORT_PREFIX,
  label: 'Imported files',
  instruments: () => [...datasets.values()].map((d) => d.instrument),
  create: (id) => new ImportedFeed(id),
});

// ------------------------------------------------------------------ IndexedDB mirror

const DB = 'htflow-imports';
const STORE = 'datasets';

interface Stored {
  id: string;
  name: string;
  instrument: Instrument;
  source: 'trades' | 'bars';
  importedAt: number;
  ts: Float64Array;
  px: Float64Array;
  qty: Float64Array;
  side: Int8Array;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const tx = <T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
) =>
  new Promise<T | undefined>((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });

async function persist(ds: ImportedDataset): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const n = ds.trades.length;
  const rec: Stored = {
    id: ds.id,
    name: ds.name,
    instrument: ds.instrument,
    source: ds.source,
    importedAt: ds.importedAt,
    ts: new Float64Array(n),
    px: new Float64Array(n),
    qty: new Float64Array(n),
    side: new Int8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const t = ds.trades[i]!;
    rec.ts[i] = t.ts;
    rec.px[i] = t.px;
    rec.qty[i] = t.qty;
    rec.side[i] = t.side === 'buy' ? 1 : t.side === 'sell' ? -1 : 0;
  }
  await tx(db, 'readwrite', (s) => s.put(rec));
  db.close();
}

async function unpersist(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.delete(id));
  db.close();
}

async function restore(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const all = (await tx(db, 'readonly', (s) => s.getAll() as IDBRequest<Stored[]>)) ?? [];
  db.close();
  for (const r of all) {
    if (datasets.has(r.id)) continue;
    const trades: Trade[] = [];
    for (let i = 0; i < r.ts.length; i++)
      trades.push({
        ts: r.ts[i]!,
        px: r.px[i]!,
        qty: r.qty[i]!,
        side: r.side[i]! > 0 ? 'buy' : r.side[i]! < 0 ? 'sell' : 'unknown',
        id: i + 1,
      });
    datasets.set(r.id, {
      id: r.id,
      name: r.name,
      instrument: r.instrument,
      trades,
      from: trades[0]?.ts ?? 0,
      to: trades.at(-1)?.ts ?? 0,
      importedAt: r.importedAt,
      source: r.source,
    });
  }
  if (all.length) notify();
}

/** Resolves once datasets saved by earlier runs are loaded back. */
const ready: Promise<void> = restore().catch(() => undefined);
