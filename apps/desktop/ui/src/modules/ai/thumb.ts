/**
 * Tiny live snapshots for the context panel: a price sparkline and a footprint-style volume
 * thumbnail, computed from the tail of the trade list (cheap, no allocation of the whole list).
 */
export interface ThumbTrade {
  ts: number;
  /** Price in ticks. */
  px: number;
  qty: number;
  side: 'buy' | 'sell' | 'unknown';
}

/** Last price (ticks) per time bin over the last `spanMs`, gaps filled forward. */
export function sparkline(
  trades: readonly ThumbTrade[],
  now: number,
  spanMs: number,
  bins: number,
): number[] {
  const from = now - spanMs;
  const out = new Array<number>(bins).fill(Number.NaN);
  let before = Number.NaN;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i]!;
    if (t.ts < from) {
      before = t.px;
      break;
    }
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((t.ts - from) / spanMs) * bins)));
    if (Number.isNaN(out[b]!)) out[b] = t.px; // iterating backwards: first hit = last trade of the bin
  }
  let carry = before;
  for (let b = 0; b < bins; b++) {
    if (Number.isNaN(out[b]!)) out[b] = carry;
    else carry = out[b]!;
  }
  const first = out.find((v) => !Number.isNaN(v));
  if (first === undefined) return [];
  return out.map((v) => (Number.isNaN(v) ? first : v));
}

export interface ThumbRow {
  px: number;
  bid: number;
  ask: number;
}

/** The busiest price levels of the last `spanMs`, highest price first (bid = sells, ask = buys). */
export function footprintRows(
  trades: readonly ThumbTrade[],
  now: number,
  spanMs: number,
  maxRows: number,
): ThumbRow[] {
  const from = now - spanMs;
  const levels = new Map<number, ThumbRow>();
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i]!;
    if (t.ts < from) break;
    let r = levels.get(t.px);
    if (!r) levels.set(t.px, (r = { px: t.px, bid: 0, ask: 0 }));
    if (t.side === 'buy') r.ask += t.qty;
    else if (t.side === 'sell') r.bid += t.qty;
    else {
      r.ask += t.qty / 2;
      r.bid += t.qty / 2;
    }
  }
  return [...levels.values()]
    .sort((a, b) => b.bid + b.ask - (a.bid + a.ask))
    .slice(0, maxRows)
    .sort((a, b) => b.px - a.px);
}
