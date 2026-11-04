import type { Bar, Cluster } from '@htflow/market-data';

export interface Row {
  /** Lowest tick of the merged row. */
  px: number;
  bid: number;
  ask: number;
  trades: number;
  vol: number;
  delta: number;
}

/** Merges a bar's clusters into rows of `rowTicks` ticks (price merging, P10). */
export function mergeRows(bar: Bar, rowTicks: number): Row[] {
  if (rowTicks <= 1) {
    const out: Row[] = [];
    for (const [px, c] of bar.clusters) out.push(toRow(px, c));
    return out.sort((a, b) => b.px - a.px);
  }
  const m = new Map<number, Row>();
  for (const [px, c] of bar.clusters) {
    const k = Math.floor(px / rowTicks) * rowTicks;
    let r = m.get(k);
    if (!r) {
      r = { px: k, bid: 0, ask: 0, trades: 0, vol: 0, delta: 0 };
      m.set(k, r);
    }
    r.bid += c.bid;
    r.ask += c.ask;
    r.trades += c.trades;
    r.vol += c.bid + c.ask;
    r.delta += c.ask - c.bid;
  }
  return [...m.values()].sort((a, b) => b.px - a.px);
}

function toRow(px: number, c: Cluster): Row {
  return { px, bid: c.bid, ask: c.ask, trades: c.trades, vol: c.bid + c.ask, delta: c.ask - c.bid };
}

export interface Imbalance {
  buy: boolean;
  sell: boolean;
}

/**
 * Diagonal imbalance: ask at row i vs bid one row below (buy); bid at row i vs ask one row above (sell).
 * Rows are sorted high → low.
 */
export function diagonalImbalances(rows: Row[], ratio: number, minVol: number): Imbalance[] {
  return rows.map((r, i) => {
    const below = rows[i + 1];
    const above = rows[i - 1];
    const buy = r.ask >= minVol && (below ? r.ask >= ratio * Math.max(below.bid, 1e-9) : false);
    const sell = r.bid >= minVol && (above ? r.bid >= ratio * Math.max(above.ask, 1e-9) : false);
    return { buy, sell };
  });
}

/** Stacked imbalance zones: runs of >= n consecutive same-side imbalances. Returns [lowPx, highPx, side]. */
export function stackedZones(
  rows: Row[],
  imb: Imbalance[],
  n: number,
): [number, number, 'buy' | 'sell'][] {
  const out: [number, number, 'buy' | 'sell'][] = [];
  for (const side of ['buy', 'sell'] as const) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= n) out.push([rows[run[run.length - 1]!]!.px, rows[run[0]!]!.px, side]);
      run = [];
    };
    for (let i = 0; i < rows.length; i++) {
      if (imb[i]![side] && (run.length === 0 || run[run.length - 1] === i - 1)) run.push(i);
      else {
        flush();
        if (imb[i]![side]) run.push(i);
      }
    }
    flush();
  }
  return out;
}
