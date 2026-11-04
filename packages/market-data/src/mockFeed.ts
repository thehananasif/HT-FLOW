import { MarketSimulator } from './simulator';
import { findMockInstrument } from './instruments';
import type {
  BookDelta,
  DepthColumn,
  EventBatch,
  FeedSource,
  FeedStatus,
  HistoryData,
  Instrument,
  Trade,
} from './types';

export interface MockFeedOptions {
  seed?: number;
  /** Hours of simulated history before "now". */
  historyHours?: number;
  /** Minutes of depth history (heatmap) before "now". */
  depthMinutes?: number;
  /** Depth sampling interval in ms. */
  depthIntervalMs?: number;
  /** Live emission interval in ms. */
  tickMs?: number;
  /** End of history; defaults to Date.now(). */
  now?: number;
}

const HIST_STEP_MS = 250;

/**
 * MockFeed: seeded random ticks + depth (fast-track rule 2). Same FeedSource interface as live
 * connectors, so every component is built against it first and later swapped onto the live bus.
 */
export class MockFeed implements FeedSource {
  readonly kind = 'mock' as const;
  readonly instrument: Instrument;
  private sim: MarketSimulator;
  private listeners = new Set<(b: EventBatch) => void>();
  private statusListeners = new Set<(s: FeedStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private historyDone = false;
  private lastWall = 0;
  private readonly opts: Required<MockFeedOptions>;

  constructor(instrumentId: string, options: MockFeedOptions = {}) {
    const m = findMockInstrument(instrumentId);
    if (!m) throw new Error(`Unknown mock instrument: ${instrumentId}`);
    this.instrument = m.instrument;
    this.opts = {
      seed: options.seed ?? hash(m.instrument.symbol),
      historyHours: options.historyHours ?? 6,
      depthMinutes: options.depthMinutes ?? 20,
      depthIntervalMs: options.depthIntervalMs ?? 250,
      tickMs: options.tickMs ?? 50,
      now: options.now ?? Date.now(),
    };
    const start = this.opts.now - this.opts.historyHours * 3_600_000;
    this.sim = new MarketSimulator({ ...m.sim, seed: this.opts.seed }, start);
  }

  /** Runs the simulator from history start to "now" as fast as possible. */
  history(): Promise<HistoryData> {
    return Promise.resolve(this.historySync());
  }

  historySync(): HistoryData {
    if (this.historyDone) throw new Error('history() already consumed');
    const trades: Trade[] = [];
    const depth: DepthColumn[] = [];
    const scratch: BookDelta[] = [];
    const end = this.opts.now;
    const depthFrom = end - this.opts.depthMinutes * 60_000;
    let nextSample = depthFrom;
    while (this.sim.t < end) {
      const dt = Math.min(HIST_STEP_MS, end - this.sim.t);
      this.sim.step(dt, trades, scratch);
      scratch.length = 0;
      if (this.sim.t >= nextSample) {
        depth.push(this.sim.depthColumn(150));
        nextSample += this.opts.depthIntervalMs;
      }
    }
    this.historyDone = true;
    return { trades, depth, book: this.sim.snapshot(), end };
  }

  subscribe(listener: (b: EventBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    if (!this.historyDone) this.historySync();
    this.lastWall = Date.now();
    this.timer = setInterval(() => this.pump(), this.opts.tickMs);
    this.emitStatus();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitStatus();
  }

  /** Advances the simulation by dt and emits one batch (exposed for tests and replay). */
  pump(dtMs?: number): EventBatch {
    const now = Date.now();
    const dt = dtMs ?? Math.min(1000, Math.max(1, now - this.lastWall));
    this.lastWall = now;
    const trades: Trade[] = [];
    const deltas: BookDelta[] = [];
    this.sim.step(dt, trades, deltas);
    const batch: EventBatch = { ts: this.sim.t, trades, deltas };
    for (const l of this.listeners) l(batch);
    return batch;
  }

  /** Current simulator book (tests only). */
  historyBookForTest(): { bids: [number, number][]; asks: [number, number][] } {
    const s = this.sim.snapshot();
    return { bids: s.bids, asks: s.asks };
  }

  private status(): FeedStatus {
    return {
      state: this.timer ? 'live' : 'disconnected',
      latencyMs: 0,
      msgsPerSec: 0,
    };
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
