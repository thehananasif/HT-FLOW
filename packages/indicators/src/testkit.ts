import { computeIndicator, type IndicatorRuntime, type SeriesOut } from '@htflow/indicator-sdk';
import type { Bar, Trade } from '@htflow/market-data';
import { indicatorById } from './index';

export const N = Number.NaN;

/** Bars from closes (o = previous close, h/l = ±1 around the body, one cluster at the close). */
export function mkBars(
  closes: number[],
  opts: { vol?: number[]; delta?: number[]; t0?: number; ms?: number } = {},
): Bar[] {
  return closes.map((c, i) => {
    const o = i > 0 ? closes[i - 1]! : c;
    const vol = opts.vol?.[i] ?? 10;
    const delta = opts.delta?.[i] ?? (c >= o ? 2 : -2);
    const buy = (vol + delta) / 2;
    const sell = (vol - delta) / 2;
    const t = (opts.t0 ?? 0) + i * (opts.ms ?? 60_000);
    return {
      t,
      tEnd: t + 59_000,
      o,
      h: Math.max(o, c) + 1,
      l: Math.min(o, c) - 1,
      c,
      vol,
      buy,
      sell,
      delta,
      maxDelta: Math.max(0, delta) + 1,
      minDelta: Math.min(0, delta) - 1,
      trades: 5,
      clusters: new Map([[c, { bid: sell, ask: buy, trades: 5, maxTrade: 3 }]]),
      closed: true,
    };
  });
}

/** Bars with explicit OHLC (volume 10, delta 0). */
export function ohlcBars(
  rows: [o: number, h: number, l: number, c: number][],
  opts: { t0?: number; ms?: number } = {},
): Bar[] {
  return rows.map(([o, h, l, c], i) => {
    const t = (opts.t0 ?? 0) + i * (opts.ms ?? 60_000);
    return {
      t,
      tEnd: t + 59_000,
      o,
      h,
      l,
      c,
      vol: 10,
      buy: 5,
      sell: 5,
      delta: 0,
      maxDelta: 1,
      minDelta: -1,
      trades: 5,
      clusters: new Map([[c, { bid: 5, ask: 5, trades: 5, maxTrade: 3 }]]),
      closed: true,
    };
  });
}

export const run = (
  id: string,
  bars: Bar[],
  inputs?: Record<string, number | string | boolean>,
  opts?: Parameters<typeof computeIndicator>[3],
) => computeIndicator(indicatorById(id)!, bars, inputs, opts);

export const vals = (rt: IndicatorRuntime, out: string): number[] =>
  Array.from((rt.outputs[out] as SeriesOut).v.slice(0, rt.count));

export const items = <T>(rt: IndicatorRuntime, out: string): T[] =>
  rt.list(out)!.items as unknown as T[];

export const mkTrades = (
  list: [ts: number, px: number, qty: number, side: 'buy' | 'sell'][],
): Trade[] => list.map(([ts, px, qty, side], id) => ({ ts, px, qty, side, id }));

export const between = (trades: Trade[]) => (from: number, to: number) =>
  trades.filter((t) => t.ts >= from && t.ts <= to);
