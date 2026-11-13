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

/**
 * Memoised `mergeRows` for renderers (P29): closed bars are merged once per row size instead of
 * on every frame. The entry is rebuilt when the bar changes (volume, trade count or price levels),
 * so the live bar stays exact. Callers must treat the returned rows as read-only.
 */
export class RowCache {
  private cache = new WeakMap<
    Bar,
    { rt: number; vol: number; trades: number; n: number; rows: Row[] }
  >();

  rows(bar: Bar, rowTicks: number): Row[] {
    const e = this.cache.get(bar);
    if (
      e &&
      e.rt === rowTicks &&
      e.vol === bar.vol &&
      e.trades === bar.trades &&
      e.n === bar.clusters.size
    )
      return e.rows;
    const rows = mergeRows(bar, rowTicks);
    this.cache.set(bar, {
      rt: rowTicks,
      vol: bar.vol,
      trades: bar.trades,
      n: bar.clusters.size,
      rows,
    });
    return rows;
  }
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

/**
 * Horizontal imbalance: ask vs bid on the same row (buy when ask ≥ ratio × bid, sell when
 * bid ≥ ratio × ask). The dominant side must reach `minVol`.
 */
export function horizontalImbalances(rows: Row[], ratio: number, minVol: number): Imbalance[] {
  return rows.map((r) => ({
    buy: r.ask > 0 && r.ask >= minVol && r.ask >= ratio * Math.max(r.bid, 1e-9),
    sell: r.bid > 0 && r.bid >= minVol && r.bid >= ratio * Math.max(r.ask, 1e-9),
  }));
}

export type ImbalanceDirection = 'diagonal' | 'horizontal';

/** Imbalances in the chosen direction (diagonal = classic footprint, horizontal = same row). */
export function imbalances(
  rows: Row[],
  dir: ImbalanceDirection,
  ratio: number,
  minVol: number,
): Imbalance[] {
  return dir === 'horizontal'
    ? horizontalImbalances(rows, ratio, minVol)
    : diagonalImbalances(rows, ratio, minVol);
}

/**
 * Value area of one bar: row indices [hi, lo] (rows sorted high → low) of the smallest block
 * around the POC holding `pct` (0..1) of the bar volume, grown one row at a time towards the
 * larger neighbour. Null for an empty bar.
 */
export function valueAreaRows(
  rows: Row[],
  pct: number,
): { hi: number; lo: number; poc: number } | null {
  if (!rows.length) return null;
  let poc = 0;
  let total = 0;
  for (let k = 0; k < rows.length; k++) {
    total += rows[k]!.vol;
    if (rows[k]!.vol > rows[poc]!.vol) poc = k;
  }
  const target = total * Math.max(0, Math.min(1, pct));
  let hi = poc;
  let lo = poc;
  let acc = rows[poc]!.vol;
  while (acc < target && (hi > 0 || lo < rows.length - 1)) {
    const up = hi > 0 ? rows[hi - 1]!.vol : -1;
    const down = lo < rows.length - 1 ? rows[lo + 1]!.vol : -1;
    if (up >= down) acc += rows[--hi]!.vol;
    else acc += rows[++lo]!.vol;
  }
  return { hi, lo, poc };
}

/** Cell filter (quick settings): a row is drawn only with volume ≥ minVolume and |delta| ≥ minDelta. */
export function passesFilter(r: Row, minVolume: number, minDelta: number): boolean {
  return r.vol >= minVolume && Math.abs(r.delta) >= minDelta;
}

/**
 * Absorption: a row at the bar's high or low whose volume is at least `factor` × the bar's
 * average row volume (heavy trading with no price progress beyond it). Returns row indices.
 */
export function absorptionRows(rows: Row[], factor = 2.5): number[] {
  if (rows.length < 3) return [];
  const avg = rows.reduce((s, r) => s + r.vol, 0) / rows.length;
  const out: number[] = [];
  for (const k of [0, rows.length - 1]) if (rows[k]!.vol >= factor * avg) out.push(k);
  return out;
}
