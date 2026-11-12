import type { Bar } from '@htflow/market-data';
import type { Imbalance, ImbalanceOpts } from './types';

/** Point of control: the price (ticks) with the most volume; ties go to the price nearest the close. */
export function pocOf(bar: Bar): number {
  let best = bar.c;
  let vol = -1;
  for (const [px, c] of bar.clusters) {
    const v = c.bid + c.ask;
    if (v > vol || (v === vol && Math.abs(px - bar.c) < Math.abs(best - bar.c))) {
      vol = v;
      best = px;
    }
  }
  return best;
}

/**
 * Diagonal imbalances (footprint convention): a buy imbalance at p when ask[p] ≥ ratio · bid[p−1],
 * a sell imbalance at p when bid[p] ≥ ratio · ask[p+1]. A zero opposite side counts as an
 * imbalance when the dominant side reaches `minVolume`.
 */
export function imbalancesOf(bar: Bar, opts: ImbalanceOpts = {}): Imbalance[] {
  const ratio = opts.ratio ?? 3;
  const minVol = opts.minVolume ?? 1;
  const out: Imbalance[] = [];
  const pxs = [...bar.clusters.keys()].sort((a, b) => a - b);
  for (const px of pxs) {
    const c = bar.clusters.get(px)!;
    const below = bar.clusters.get(px - 1)?.bid ?? 0;
    const above = bar.clusters.get(px + 1)?.ask ?? 0;
    if (c.ask >= minVol && c.ask >= ratio * below)
      out.push({ px, side: 'buy', ratio: below > 0 ? c.ask / below : Infinity });
    if (c.bid >= minVol && c.bid >= ratio * above)
      out.push({ px, side: 'sell', ratio: above > 0 ? c.bid / above : Infinity });
  }
  return out;
}

/** Longest run of consecutive prices with same-side imbalances. */
export function stackedOf(
  bar: Bar,
  opts: ImbalanceOpts = {},
): { count: number; side: 'buy' | 'sell' | null; from: number; to: number } {
  const imb = imbalancesOf(bar, opts);
  let best = { count: 0, side: null as 'buy' | 'sell' | null, from: Number.NaN, to: Number.NaN };
  for (const side of ['buy', 'sell'] as const) {
    const pxs = imb.filter((x) => x.side === side).map((x) => x.px);
    let start = 0;
    for (let k = 1; k <= pxs.length; k++) {
      if (k < pxs.length && pxs[k] === pxs[k - 1]! + 1) continue;
      const n = k - start;
      // Ties: the run nearer the close wins (more recent pressure).
      if (n > best.count) best = { count: n, side, from: pxs[start]!, to: pxs[k - 1]! };
      start = k;
    }
  }
  return best;
}

/** Bid / ask volume at one price of a bar. */
export function volumeAt(bar: Bar, px: number): { bid: number; ask: number; total: number } {
  const c = bar.clusters.get(px);
  const bid = c?.bid ?? 0;
  const ask = c?.ask ?? 0;
  return { bid, ask, total: bid + ask };
}
