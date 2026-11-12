import { Channel, invoke } from '@tauri-apps/api/core';
import {
  MockFeed,
  type BookDelta,
  type EventBatch,
  type FeedSource,
  type FeedStatus,
  type HistoryData,
  type Instrument,
  type MarketStat,
  type Trade,
} from '@htflow/market-data';
import { isTauri } from '../backend';

/** Wire format of one coalesced batch from the Rust UI streamer (Live Pipeline stage 9). */
interface WireBatch {
  t: number;
  /** [ts_ms, px_ticks, qty, side (1 buy, -1 sell, 0 unknown), id] */
  tr: [number, number, number, number, number][];
  /** [side (1 bid, -1 ask), px_ticks, qty] */
  bd: [number, number, number][];
  snap?: { bids: [number, number][]; asks: [number, number][] };
  /** Funding / open interest / liquidations (Rust `MarketStat`, tagged by `kind`). */
  ex?: WireStat[];
  st?: {
    state: FeedStatus['state'];
    latency_ms: number;
    msgs_per_sec: number;
    message?: string;
    /** Book resyncs since subscribe. */
    rs?: number;
    /** Being recorded to the tick store. */
    rec?: boolean;
  };
}

type WireStat =
  | { kind: 'funding'; ts_ns: number; rate: number; next_ts_ns: number; mark_price: number | null }
  | { kind: 'open_interest'; ts_ns: number; oi: number; value: number | null }
  | { kind: 'liquidation'; ts_ns: number; side: 'buy' | 'sell'; px: number; qty: number };

/** Rust stats → UI stats (ns → ms; NaN is serialised as null). */
export function toStats(rows: WireStat[]): MarketStat[] {
  const num = (v: number | null) => (v === null ? Number.NaN : v);
  return rows.map((r): MarketStat => {
    const ts = Math.floor(r.ts_ns / 1e6);
    if (r.kind === 'funding')
      return {
        kind: 'funding',
        ts,
        rate: r.rate,
        nextTs: Math.floor(r.next_ts_ns / 1e6),
        markPrice: num(r.mark_price),
      };
    if (r.kind === 'open_interest')
      return { kind: 'open_interest', ts, oi: r.oi, value: num(r.value) };
    return { kind: 'liquidation', ts, side: r.side, px: r.px, qty: r.qty };
  });
}

interface WireHistory {
  tick_size: number;
  price_precision: number;
  qty_precision: number;
  trades: [number, number, number, number, number][];
  book: { bids: [number, number][]; asks: [number, number][] };
  end: number;
  local?: number;
  backfilled?: number;
}

const side = (s: number): Trade['side'] => (s > 0 ? 'buy' : s < 0 ? 'sell' : 'unknown');
const toTrades = (rows: WireBatch['tr']): Trade[] =>
  rows.map(([ts, px, qty, s, id]) => ({ ts, px, qty, side: side(s), id }));

/** Live venues served by the Rust connectors. */
export const LIVE_VENUES = [
  'binance-futures',
  'binance-coinm',
  'binance-spot',
  'bybit-linear',
  'okx-swap',
  'deribit',
  'bitget',
] as const;

// ------------------------------------------------------------------ venue control (Connections)

const feeds = new Set<TauriLiveFeed>();
const disabled = new Set<string>();
const venueListeners = new Set<() => void>();

/** Connect / disconnect a venue: pauses or resumes every live feed of it. */
export function setVenueEnabled(venue: string, on: boolean): void {
  if (on === !disabled.has(venue)) return;
  if (on) disabled.delete(venue);
  else disabled.add(venue);
  for (const f of feeds) {
    if (f.venue !== venue) continue;
    if (on) f.resume();
    else f.pause();
  }
  venueListeners.forEach((l) => l());
}

export function isVenueEnabled(venue: string): boolean {
  return !disabled.has(venue);
}

export function onVenueChange(fn: () => void): () => void {
  venueListeners.add(fn);
  return () => venueListeners.delete(fn);
}

export interface VenueStats {
  feeds: number;
  live: number;
  latencyMs: number;
  msgsPerSec: number;
  resyncs: number;
  recording: number;
  /** Worst state across feeds, with its message. */
  state: FeedStatus['state'] | 'idle';
  message?: string;
}

const RANK: Record<FeedStatus['state'], number> = {
  live: 0,
  replay: 0,
  delayed: 1,
  connecting: 2,
  disconnected: 3,
  error: 4,
};

/** Aggregated status of every live feed of a venue (Connections window). */
export function venueStats(venue: string): VenueStats {
  const list = [...feeds].filter((f) => f.venue === venue);
  const s: VenueStats = {
    feeds: list.length,
    live: 0,
    latencyMs: 0,
    msgsPerSec: 0,
    resyncs: 0,
    recording: 0,
    state: 'idle',
  };
  let worst = -1;
  for (const f of list) {
    const st = f.currentStatus();
    if (st.state === 'live') s.live++;
    s.latencyMs += st.latencyMs / list.length;
    s.msgsPerSec += st.msgsPerSec;
    s.resyncs += f.resyncs;
    if (f.recording) s.recording++;
    if (RANK[st.state] > worst) {
      worst = RANK[st.state];
      s.state = st.state;
      s.message = st.message;
    }
  }
  return s;
}

// ------------------------------------------------------------------ feed

/**
 * FeedSource backed by a Rust connector over a Tauri channel, for any venue the core knows
 * (`binance-futures`, `bybit-linear`).
 *
 * Live Pipeline stage 6 (e–g): history() subscribes to the live stream first and buffers it while
 * the history request (local tick store + REST backfill) runs; start() then replays the buffer,
 * dropping trades already contained in the history (same trade id), so the chart gets one
 * continuous stream with no gap and no duplicate at the seam.
 */
export class TauriLiveFeed implements FeedSource {
  readonly kind = 'live' as const;
  private listeners = new Set<(b: EventBatch) => void>();
  private statusListeners = new Set<(s: FeedStatus) => void>();
  private subId: number | null = null;
  private subscribing = false;
  private started = false;
  private buffering = true;
  private buffer: EventBatch[] = [];
  private seamIds: Set<number> | null = null;
  private seamUntil = 0;
  private status: FeedStatus = { state: 'connecting', latencyMs: 0, msgsPerSec: 0 };
  resyncs = 0;
  recording = false;
  /** Trades served from the local store / downloaded by the last history call. */
  historyInfo = { local: 0, backfilled: 0 };

  constructor(
    readonly instrument: Instrument,
    readonly venue: string,
    private historyMinutes = 30,
  ) {
    feeds.add(this);
  }

  currentStatus(): FeedStatus {
    return this.status;
  }

  private setStatus(s: FeedStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async history(): Promise<HistoryData> {
    if (isVenueEnabled(this.venue)) this.connect();
    const h = await invoke<WireHistory>('market_history', {
      venue: this.venue,
      symbol: this.instrument.symbol,
      minutes: this.historyMinutes,
    });
    // Exchange-reported precision wins over the built-in defaults.
    this.instrument.tickSize = h.tick_size;
    this.instrument.pricePrecision = h.price_precision;
    this.instrument.qtyPrecision = h.qty_precision;
    this.historyInfo = { local: h.local ?? 0, backfilled: h.backfilled ?? 0 };
    const trades = toTrades(h.trades);
    // Ids of the last few seconds of history: live duplicates of these are dropped.
    const tail = trades.filter((t) => t.ts >= h.end - 15_000);
    this.seamIds = new Set(tail.map((t) => t.id));
    this.seamUntil = h.end + 15_000;
    return {
      trades,
      depth: [],
      book: { ts: h.end, bids: h.book.bids, asks: h.book.asks },
      end: h.end,
    };
  }

  subscribe(l: (b: EventBatch) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: FeedStatus) => void): () => void {
    this.statusListeners.add(l);
    l(this.status);
    return () => this.statusListeners.delete(l);
  }

  private emit(batch: EventBatch): void {
    if (this.seamIds) {
      if (batch.ts > this.seamUntil) this.seamIds = null;
      else {
        const ids = this.seamIds;
        batch = { ...batch, trades: batch.trades.filter((t) => !ids.has(t.id)) };
      }
    }
    if (!batch.trades.length && !batch.deltas.length && !batch.snapshot && !batch.stats?.length)
      return;
    for (const l of this.listeners) l(batch);
  }

  private connect(): void {
    if (this.subId !== null || this.subscribing) return;
    this.subscribing = true;
    const ch = new Channel<WireBatch>();
    ch.onmessage = (m) => {
      if (m.st) {
        this.resyncs = m.st.rs ?? this.resyncs;
        this.recording = m.st.rec ?? false;
        this.setStatus({
          state: m.st.state,
          latencyMs: m.st.latency_ms,
          msgsPerSec: m.st.msgs_per_sec,
          message: m.st.message,
        });
      }
      if (!m.tr.length && !m.bd.length && !m.snap && !m.ex?.length) return;
      const deltas: BookDelta[] = m.bd.map(([s, px, qty]) => ({
        side: s > 0 ? 'buy' : 'sell',
        px,
        qty,
      }));
      const batch: EventBatch = { ts: m.t, trades: toTrades(m.tr), deltas };
      if (m.snap) batch.snapshot = { ts: m.t, bids: m.snap.bids, asks: m.snap.asks };
      if (m.ex?.length) batch.stats = toStats(m.ex);
      if (this.buffering) {
        // Bounded: if history takes very long, keep the newest ~2 minutes of batches.
        if (this.buffer.length > 8000) this.buffer.splice(0, 1000);
        this.buffer.push(batch);
      } else this.emit(batch);
    };
    void invoke<number>('market_subscribe', {
      venue: this.venue,
      symbol: this.instrument.symbol,
      channel: ch,
    })
      .then((id) => {
        this.subscribing = false;
        // Paused or stopped while subscribing.
        if (!isVenueEnabled(this.venue) || (!this.started && !this.buffering)) {
          void invoke('market_unsubscribe', { id });
          return;
        }
        this.subId = id;
      })
      .catch((e: unknown) => {
        this.subscribing = false;
        const msg =
          e && typeof e === 'object' && 'message' in e
            ? String((e as { message: unknown }).message)
            : String(e);
        this.setStatus({ state: 'error', latencyMs: 0, msgsPerSec: 0, message: msg });
      });
  }

  private disconnect(): void {
    if (this.subId !== null) void invoke('market_unsubscribe', { id: this.subId });
    this.subId = null;
  }

  start(): void {
    this.started = true;
    this.buffering = false;
    const pending = this.buffer;
    this.buffer = [];
    for (const b of pending) this.emit(b);
    if (!isVenueEnabled(this.venue)) {
      this.pause();
      return;
    }
    this.connect();
  }

  /** Disconnect (Connections → Disconnect). The feed stays registered and can resume. */
  pause(): void {
    this.disconnect();
    this.setStatus({
      state: 'disconnected',
      latencyMs: 0,
      msgsPerSec: 0,
      message: 'Disconnected in Connections',
    });
  }

  resume(): void {
    if (!this.started) return;
    this.setStatus({ state: 'connecting', latencyMs: 0, msgsPerSec: 0 });
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.buffering = false;
    this.buffer = [];
    this.disconnect();
    feeds.delete(this);
  }
}

/** Builds a feed for a live venue instrument: the Rust connector in the desktop app, a simulator
 * on the same symbol in the browser preview (which has no native connectors). */
export function createLiveFeed(inst: Instrument, venue: string): FeedSource {
  if (isTauri) return new TauriLiveFeed({ ...inst }, venue);
  return new MockFeed('BTCUSDT');
}

/** Instrument list helper for live feed providers. */
export function liveInstruments(
  prefix: string,
  exchange: string,
  rows: [symbol: string, tick: number, pricePrecision: number, qtyPrecision: number][],
  displaySuffix = 'Perpetual',
): Instrument[] {
  return rows.map(([symbol, tickSize, pricePrecision, qtyPrecision]) => ({
    id: `${prefix}${symbol}`,
    symbol,
    displayName: `${symbol} ${displaySuffix}`,
    exchange,
    assetClass: 'crypto',
    tickSize,
    pricePrecision,
    qtyPrecision,
    tickValue: 0,
    currency: 'USDT',
  }));
}
