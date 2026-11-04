import type { Bar } from './aggregator';

export interface ProfileLevel {
  vol: number;
  buy: number;
  sell: number;
}

export interface VolumeProfile {
  levels: Map<number, ProfileLevel>;
  total: number;
  buy: number;
  sell: number;
  maxVol: number;
  poc: number;
  vah: number;
  val: number;
  low: number;
  high: number;
}

/** Volume-at-price for bars [from, to] inclusive, with POC and value area. */
export function buildProfile(
  bars: readonly Bar[],
  from: number,
  to: number,
  valueAreaPct = 0.7,
): VolumeProfile {
  const levels = new Map<number, ProfileLevel>();
  let total = 0;
  let buy = 0;
  let sell = 0;
  const lo = Math.max(0, from);
  const hi = Math.min(bars.length - 1, to);
  for (let i = lo; i <= hi; i++) {
    const b = bars[i]!;
    for (const [px, c] of b.clusters) {
      let l = levels.get(px);
      if (!l) {
        l = { vol: 0, buy: 0, sell: 0 };
        levels.set(px, l);
      }
      const v = c.bid + c.ask;
      l.vol += v;
      l.buy += c.ask;
      l.sell += c.bid;
      total += v;
      buy += c.ask;
      sell += c.bid;
    }
  }
  return finishProfile(levels, total, buy, sell, valueAreaPct);
}

export function finishProfile(
  levels: Map<number, ProfileLevel>,
  total: number,
  buy: number,
  sell: number,
  valueAreaPct = 0.7,
): VolumeProfile {
  let maxVol = 0;
  let poc = Number.NaN;
  let low = Infinity;
  let high = -Infinity;
  for (const [px, l] of levels) {
    if (l.vol > maxVol || (l.vol === maxVol && px < poc)) {
      maxVol = l.vol;
      poc = px;
    }
    if (px < low) low = px;
    if (px > high) high = px;
  }
  const { vah, val } = valueArea(levels, poc, low, high, total, valueAreaPct);
  return { levels, total, buy, sell, maxVol, poc, vah, val, low, high };
}

/**
 * Classic value-area expansion: start at POC, repeatedly add the neighbouring
 * price (above or below) with the larger volume until pct of total is covered.
 */
export function valueArea(
  levels: Map<number, ProfileLevel>,
  poc: number,
  low: number,
  high: number,
  total: number,
  pct: number,
): { vah: number; val: number } {
  if (Number.isNaN(poc)) return { vah: Number.NaN, val: Number.NaN };
  const target = total * pct;
  let acc = levels.get(poc)?.vol ?? 0;
  let up = poc;
  let dn = poc;
  while (acc < target && (up < high || dn > low)) {
    const vUp = up < high ? (levels.get(up + 1)?.vol ?? 0) : -1;
    const vDn = dn > low ? (levels.get(dn - 1)?.vol ?? 0) : -1;
    if (vUp >= vDn) {
      up++;
      acc += Math.max(0, vUp);
    } else {
      dn--;
      acc += Math.max(0, vDn);
    }
  }
  return { vah: up, val: dn };
}
