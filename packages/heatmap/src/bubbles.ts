import type { Trade } from '@htflow/market-data';

export type BubbleCalc = 'volume' | 'delta';
/** plain = one neutral colour, pie = buy / sell slices, dominant = colour of the larger side. */
export type BubbleStyle = 'plain' | 'pie' | 'dominant';

export interface Bubble {
  /** Slot (column) of the first trade. */
  slot: number;
  /** First / last trade time (ms). */
  t: number;
  last: number;
  /** Volume-weighted price (ticks). */
  px: number;
  buy: number;
  sell: number;
  trades: number;
  /** Size used for radius / filtering (volume or |delta|). */
  size: number;
}

export interface BubbleOptions {
  /** 0..10: merges trades within N ticks and N × 100 ms. */
  clustering: number;
  calc: BubbleCalc;
  /** Bubbles smaller than this (in `calc` units) are dropped. */
  minSize: number;
}

/**
 * Slot of each trade: the last slot whose column time is ≤ the trade time. Trades before the first
 * slot are skipped (-1). `timeAt` must be non-decreasing.
 */
export function slotOfTrades(
  trades: readonly Trade[],
  timeAt: (i: number) => number | undefined,
  i0: number,
  i1: number,
): Int32Array {
  const out = new Int32Array(trades.length).fill(-1);
  let s = i0;
  const t0 = timeAt(i0);
  if (t0 === undefined) return out;
  for (let k = 0; k < trades.length; k++) {
    const ts = trades[k]!.ts;
    if (ts < t0) continue;
    while (s < i1) {
      const nt = timeAt(s + 1);
      if (nt === undefined || nt > ts) break;
      s++;
    }
    out[k] = s;
  }
  return out;
}

/** Aggregates trades into bubbles (P11 Bubbles: Clustering, Calc Volume|Delta, min size). */
export function aggregateBubbles(
  trades: readonly Trade[],
  slots: Int32Array,
  opts: BubbleOptions,
): Bubble[] {
  const c = Math.max(0, Math.min(10, opts.clustering));
  const bucketTicks = Math.floor(c) + 1;
  const clusterMs = c * 100;
  const open = new Map<number, Bubble & { pxq: number }>();
  const all: (Bubble & { pxq: number })[] = [];
  for (let k = 0; k < trades.length; k++) {
    const slot = slots[k]!;
    if (slot < 0) continue;
    const tr = trades[k]!;
    const bucket = Math.floor(tr.px / bucketTicks);
    let b = open.get(bucket);
    if (!b || (b.slot !== slot && tr.ts - b.last > clusterMs)) {
      b = { slot, t: tr.ts, last: tr.ts, px: tr.px, buy: 0, sell: 0, trades: 0, size: 0, pxq: 0 };
      open.set(bucket, b);
      all.push(b);
    }
    if (tr.side === 'buy') b.buy += tr.qty;
    else if (tr.side === 'sell') b.sell += tr.qty;
    else {
      b.buy += tr.qty / 2;
      b.sell += tr.qty / 2;
    }
    b.trades++;
    b.last = tr.ts;
    b.pxq += tr.px * tr.qty;
  }
  const out: Bubble[] = [];
  for (const b of all) {
    const vol = b.buy + b.sell;
    const size = opts.calc === 'delta' ? Math.abs(b.buy - b.sell) : vol;
    if (size < opts.minSize || size <= 0) continue;
    out.push({
      slot: b.slot,
      t: b.t,
      last: b.last,
      px: vol > 0 ? b.pxq / vol : b.px,
      buy: b.buy,
      sell: b.sell,
      trades: b.trades,
      size,
    });
  }
  return out;
}

/** Radius in px for a bubble: `scale` is the Size setting (1..100). */
export function bubbleRadius(size: number, maxSize: number, scale: number): number {
  const maxR = 4 + Math.max(1, Math.min(100, scale)) * 0.4;
  return Math.max(2.5, Math.sqrt(size / Math.max(1e-9, maxSize)) * maxR);
}

export interface PlacedBubble {
  b: Bubble;
  x: number;
  y: number;
  r: number;
}

/** Topmost bubble under (x, y) — the smallest one wins when several overlap. */
export function bubbleAt(
  placed: readonly PlacedBubble[],
  x: number,
  y: number,
): PlacedBubble | null {
  let best: PlacedBubble | null = null;
  for (const p of placed) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= p.r * p.r && (!best || p.r < best.r)) best = p;
  }
  return best;
}

/** Tooltip rows of a bubble: price, time (ms), Vol, Buy x (%), Sell x (%), Trades. */
export function bubbleSummary(b: Bubble): {
  vol: number;
  buy: number;
  sell: number;
  buyPct: number;
  sellPct: number;
  trades: number;
  side: 'BID' | 'ASK';
} {
  const vol = b.buy + b.sell;
  const buyPct = vol > 0 ? Math.round((b.buy / vol) * 100) : 0;
  return {
    vol,
    buy: b.buy,
    sell: b.sell,
    buyPct,
    sellPct: vol > 0 ? 100 - buyPct : 0,
    trades: b.trades,
    // Aggressive sellers hit the bid; aggressive buyers lift the ask.
    side: b.sell > b.buy ? 'BID' : 'ASK',
  };
}

/** Buy / sell volume per slot in [i0, i1] (volume bars). */
export function slotVolumes(
  trades: readonly Trade[],
  slots: Int32Array,
  i0: number,
  i1: number,
): { buy: Float64Array; sell: Float64Array } {
  const n = Math.max(0, i1 - i0 + 1);
  const buy = new Float64Array(n);
  const sell = new Float64Array(n);
  for (let k = 0; k < trades.length; k++) {
    const s = slots[k]!;
    if (s < i0 || s > i1) continue;
    const tr = trades[k]!;
    const j = s - i0;
    if (tr.side === 'buy') buy[j] = buy[j]! + tr.qty;
    else if (tr.side === 'sell') sell[j] = sell[j]! + tr.qty;
    else {
      buy[j] = buy[j]! + tr.qty / 2;
      sell[j] = sell[j]! + tr.qty / 2;
    }
  }
  return { buy, sell };
}
