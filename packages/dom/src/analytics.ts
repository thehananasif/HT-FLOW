/** Pure per-price analytics used by the Smart DOM (value area, cumulative depth). */

export interface ValueArea {
  /** Point of control (price with the most volume); NaN when there is no volume. */
  poc: number;
  vah: number;
  val: number;
  total: number;
}

/**
 * Value area: start at the POC and repeatedly add the neighbouring price (above or below) with the
 * larger volume until `pct` of the total volume is covered. Ties expand upward first. Gaps between
 * traded prices count as zero-volume ticks. The POC tie-break is the price nearest the middle of
 * the traded range, then the lower price.
 */
export function computeValueArea(volume: ReadonlyMap<number, number>, pct = 0.7): ValueArea {
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (const [px, v] of volume) {
    if (v <= 0) continue;
    if (px < lo) lo = px;
    if (px > hi) hi = px;
    total += v;
  }
  if (!(total > 0)) return { poc: Number.NaN, vah: Number.NaN, val: Number.NaN, total: 0 };
  const mid = (lo + hi) / 2;
  let poc = Number.NaN;
  let best = -1;
  for (const [px, v] of volume) {
    if (v <= 0) continue;
    if (
      v > best ||
      (v === best &&
        (Math.abs(px - mid) < Math.abs(poc - mid) ||
          (Math.abs(px - mid) === Math.abs(poc - mid) && px < poc)))
    ) {
      best = v;
      poc = px;
    }
  }
  const target = total * Math.min(1, Math.max(0, pct));
  let acc = best;
  let up = poc;
  let down = poc;
  const at = (px: number) => Math.max(0, volume.get(px) ?? 0);
  while (acc < target - 1e-9 && (up < hi || down > lo)) {
    const a = up < hi ? at(up + 1) : -1;
    const b = down > lo ? at(down - 1) : -1;
    if (a >= b) {
      up++;
      acc += a;
    } else {
      down--;
      acc += b;
    }
  }
  return { poc, vah: up, val: down, total };
}

export interface CumulativeDepth {
  /** Index i = price `lo + i`. Bid totals include every bid at or above the price. */
  bid: Float64Array;
  /** Ask totals include every ask at or below the price. */
  ask: Float64Array;
  lo: number;
  hi: number;
}

/**
 * Cumulative resting size from the inside market outward, for prices `lo..hi` (ticks). A bid row
 * shows everything a sell market order would hit down to that price; an ask row the same upward.
 * Cost: one pass over the book plus one pass over the range.
 */
export function cumulativeDepth(
  bids: ReadonlyMap<number, number>,
  asks: ReadonlyMap<number, number>,
  lo: number,
  hi: number,
): CumulativeDepth {
  const n = Math.max(0, hi - lo + 1);
  const bid = new Float64Array(n);
  const ask = new Float64Array(n);
  let bidAbove = 0;
  for (const [px, q] of bids) {
    if (px > hi) bidAbove += q;
    else if (px >= lo) bid[px - lo] = q;
  }
  let askBelow = 0;
  for (const [px, q] of asks) {
    if (px < lo) askBelow += q;
    else if (px <= hi) ask[px - lo] = q;
  }
  let acc = bidAbove;
  for (let i = n - 1; i >= 0; i--) {
    acc += bid[i]!;
    bid[i] = acc;
  }
  acc = askBelow;
  for (let i = 0; i < n; i++) {
    acc += ask[i]!;
    ask[i] = acc;
  }
  return { bid, ask, lo, hi };
}
