import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  BookDelta,
  EventBatch,
  FeedSource,
  FeedStatus,
  HistoryData,
  Instrument,
  Trade,
} from '@htflow/market-data';

/** Wire format of one coalesced batch from the Rust UI streamer (Live Pipeline stage 9). */
interface WireBatch {
  t: number;
  /** [ts_ms, px_ticks, qty, side (1 buy, -1 sell, 0 unknown), id] */
  tr: [number, number, number, number, number][];
  /** [side (1 bid, -1 ask), px_ticks, qty] */
  bd: [number, number, number][];
  snap?: { bids: [number, number][]; asks: [number, number][] };
  st?: { state: FeedStatus['state']; latency_ms: number; msgs_per_sec: number; message?: string };
}

interface WireHistory {
  tick_size: number;
  price_precision: number;
  qty_precision: number;
  trades: [number, number, number, number, number][];
  book: { bids: [number, number][]; asks: [number, number][] };
  end: number;
}

const side = (s: number): Trade['side'] => (s > 0 ? 'buy' : s < 0 ? 'sell' : 'unknown');
const toTrades = (rows: WireBatch['tr']): Trade[] =>
  rows.map(([ts, px, qty, s, id]) => ({ ts, px, qty, side: side(s), id }));

/** FeedSource backed by a Rust connector over a Tauri channel. */
export class TauriLiveFeed implements FeedSource {
  readonly kind = 'live' as const;
  private listeners = new Set<(b: EventBatch) => void>();
  private statusListeners = new Set<(s: FeedStatus) => void>();
  private subId: number | null = null;
  private status: FeedStatus = { state: 'connecting', latencyMs: 0, msgsPerSec: 0 };

  constructor(
    readonly instrument: Instrument,
    private venue: string,
    private historyMinutes = 30,
  ) {}

  async history(): Promise<HistoryData> {
    const h = await invoke<WireHistory>('market_history', {
      venue: this.venue,
      symbol: this.instrument.symbol,
      minutes: this.historyMinutes,
    });
    // Exchange-reported precision wins over the built-in defaults.
    this.instrument.tickSize = h.tick_size;
    this.instrument.pricePrecision = h.price_precision;
    this.instrument.qtyPrecision = h.qty_precision;
    return {
      trades: toTrades(h.trades),
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

  start(): void {
    if (this.subId !== null) return;
    const ch = new Channel<WireBatch>();
    ch.onmessage = (m) => {
      if (m.st) {
        this.status = {
          state: m.st.state,
          latencyMs: m.st.latency_ms,
          msgsPerSec: m.st.msgs_per_sec,
          message: m.st.message,
        };
        for (const l of this.statusListeners) l(this.status);
      }
      if (!m.tr.length && !m.bd.length && !m.snap) return;
      const deltas: BookDelta[] = m.bd.map(([s, px, qty]) => ({
        side: s > 0 ? 'buy' : 'sell',
        px,
        qty,
      }));
      const batch: EventBatch = { ts: m.t, trades: toTrades(m.tr), deltas };
      if (m.snap) batch.snapshot = { ts: m.t, bids: m.snap.bids, asks: m.snap.asks };
      for (const l of this.listeners) l(batch);
    };
    void invoke<number>('market_subscribe', {
      venue: this.venue,
      symbol: this.instrument.symbol,
      channel: ch,
    })
      .then((id) => (this.subId = id))
      .catch((e: unknown) => {
        this.status = { state: 'error', latencyMs: 0, msgsPerSec: 0, message: String(e) };
        for (const l of this.statusListeners) l(this.status);
      });
  }

  stop(): void {
    if (this.subId !== null) void invoke('market_unsubscribe', { id: this.subId });
    this.subId = null;
  }
}
