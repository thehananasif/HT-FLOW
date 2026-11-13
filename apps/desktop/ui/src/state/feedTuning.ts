/**
 * Settings → Data (P27) applied to live feeds on the UI side: book-update conflation, local
 * receive timestamps and re-subscribe back-off. Pure helpers (tested) + a small conflator.
 */
import type { EventBatch } from '@htflow/market-data';

/** Merges consecutive batches into one: trades / deltas / stats in order; a snapshot drops the deltas before it. */
export function mergeBatches(batches: readonly EventBatch[]): EventBatch | null {
  if (!batches.length) return null;
  const out: EventBatch = { ts: batches[batches.length - 1]!.ts, trades: [], deltas: [] };
  for (const b of batches) {
    out.trades.push(...b.trades);
    if (b.snapshot) {
      out.snapshot = b.snapshot;
      out.deltas = [];
    }
    out.deltas.push(...b.deltas);
    if (b.stats?.length) (out.stats ??= []).push(...b.stats);
  }
  return out;
}

/** Local receive time instead of exchange time (Settings → Data → timestamp source). */
export function restamp(b: EventBatch, now: number): EventBatch {
  return {
    ...b,
    ts: now,
    trades: b.trades.map((t) => ({ ...t, ts: now })),
    ...(b.snapshot ? { snapshot: { ...b.snapshot, ts: now } } : {}),
  };
}

/** Exponential back-off: 0.5 s, 1 s, 2 s … capped at `maxSec`. */
export function reconnectDelayMs(attempt: number, maxSec: number): number {
  return Math.min(Math.max(1, maxSec) * 1000, 500 * 2 ** Math.max(0, Math.min(20, attempt)));
}

/** Collects batches for `windowMs` and emits them merged (0 = pass through). */
export class Conflator {
  private pending: EventBatch[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private emit: (b: EventBatch) => void,
    private windowMs: () => number,
  ) {}

  push(b: EventBatch): void {
    const w = this.windowMs();
    if (w <= 0 && !this.pending.length) {
      this.emit(b);
      return;
    }
    this.pending.push(b);
    this.timer ??= setTimeout(() => this.flush(), Math.max(0, w));
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const m = mergeBatches(this.pending);
    this.pending = [];
    if (m) this.emit(m);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
