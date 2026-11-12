import { BarSeries, type Bar, type BarSpec, type Trade } from '@htflow/market-data';

/**
 * Ghost (future) bars for "Hide future bars = off" (P24): bars built from the trades the replay
 * has not played yet. They are drawn faded after the last real bar and never enter the market
 * store, so indicators and drawings still see only the past.
 */

export interface GhostOptions {
  /** Maximum number of ghost bars returned. */
  maxBars?: number;
  /** Upper limit of trades aggregated (keeps the redraw cheap on huge datasets). */
  maxTrades?: number;
}

/**
 * Future bars after the bar that contains the replay clock.
 * @param trades full dataset trades in time order
 * @param fromIndex index of the next trade to be replayed (`engine.tradeIndex`)
 * @param lastBarT open time of the last real bar (null when there is none)
 */
export function ghostBars(
  trades: readonly Trade[],
  fromIndex: number,
  spec: BarSpec,
  lastBarT: number | null,
  opt: GhostOptions = {},
): Bar[] {
  const maxBars = Math.max(0, opt.maxBars ?? 60);
  const maxTrades = opt.maxTrades ?? 200_000;
  if (!maxBars || fromIndex >= trades.length) return [];
  let slice = trades.slice(fromIndex, fromIndex + maxTrades);
  if (spec.kind === 'time' && lastBarT !== null) {
    // Trades that still belong to the running bar are not "future": start at the next boundary.
    const next = lastBarT + spec.ms;
    const k = slice.findIndex((t) => t.ts >= next);
    if (k < 0) return [];
    slice = slice.slice(k);
  }
  const bars = BarSeries.build(spec, slice).bars;
  // Count-based bars: the first one continues the running bar, so it is not a future bar.
  const out = spec.kind === 'time' ? bars : bars.slice(1);
  return out.slice(0, maxBars);
}

/** Ghost candle geometry in the chart's slot space: slot i of the ghost bar k is `lastSlot + 1 + k`. */
export function ghostSlot(lastSlot: number, k: number): number {
  return lastSlot + 1 + k;
}

/** Price range (ticks) of the ghost bars that fall inside slots [i0, i1], for optional autoscale. */
export function ghostRange(
  bars: readonly Bar[],
  lastSlot: number,
  i0: number,
  i1: number,
): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < bars.length; k++) {
    const s = ghostSlot(lastSlot, k);
    if (s < i0 || s > i1) continue;
    lo = Math.min(lo, bars[k]!.l);
    hi = Math.max(hi, bars[k]!.h);
  }
  return hi >= lo ? [lo, hi] : null;
}
