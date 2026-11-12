import type { Bar } from './aggregator';
import { valueArea, type ProfileLevel } from './profile';

/** TPO (Market Profile) letters: A–Z then a–z, repeating. */
export const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export interface TpoPeriod {
  /** Period open time. */
  t: number;
  /** Index of the period inside its profile (letter = TPO_LETTERS[idx % 52]). */
  idx: number;
  letter: string;
  /** Lowest / highest row (row index = floor(px / rowTicks)). */
  lo: number;
  hi: number;
  open: number;
  close: number;
}

export interface TpoProfile {
  /** Profile key (session / split start time). */
  start: number;
  end: number;
  rowTicks: number;
  periods: TpoPeriod[];
  /** Row index → period indices that touched it (in time order). */
  rows: Map<number, number[]>;
  total: number;
  maxCount: number;
  /** Rows (indices) — multiply by rowTicks for ticks. */
  poc: number;
  vah: number;
  val: number;
  lo: number;
  hi: number;
  ibLo: number;
  ibHi: number;
  /** Rows with exactly one TPO (single prints). */
  singles: number[];
  open: number;
  close: number;
}

export interface TpoOptions {
  /** Ticks per TPO row. */
  rowTicks: number;
  /** Value area share (0..1), default 0.7. */
  valueAreaPct?: number;
  /** Periods that form the initial balance, default 2 (first hour of 30-min periods). */
  ibPeriods?: number;
  /** Profile key for a period open time — splits / merges profiles (default: UTC day). */
  profileKey?: (t: number) => number;
}

const DAY = 86_400_000;

/**
 * Builds TPO profiles from period bars (time bars whose length is the TPO period, e.g. 30 min).
 * Pure and deterministic: same bars → same profiles. Each period puts its letter on every row
 * between its low and high.
 */
export function buildTpo(bars: readonly Bar[], opts: TpoOptions): TpoProfile[] {
  const rt = Math.max(1, Math.floor(opts.rowTicks));
  const key = opts.profileKey ?? ((t: number) => Math.floor(t / DAY) * DAY);
  const ib = Math.max(1, opts.ibPeriods ?? 2);
  const out: TpoProfile[] = [];
  let cur: TpoProfile | null = null;
  for (const b of bars) {
    if (b.trades === 0 && b.vol === 0) continue;
    const k = key(b.t);
    if (!cur || cur.start !== k) {
      if (cur) finish(cur, opts.valueAreaPct ?? 0.7, ib);
      cur = {
        start: k,
        end: b.tEnd,
        rowTicks: rt,
        periods: [],
        rows: new Map(),
        total: 0,
        maxCount: 0,
        poc: Number.NaN,
        vah: Number.NaN,
        val: Number.NaN,
        lo: Infinity,
        hi: -Infinity,
        ibLo: Infinity,
        ibHi: -Infinity,
        singles: [],
        open: Math.floor(b.o / rt),
        close: Math.floor(b.c / rt),
      };
      out.push(cur);
    }
    const idx = cur.periods.length;
    const lo = Math.floor(b.l / rt);
    const hi = Math.floor(b.h / rt);
    cur.periods.push({
      t: b.t,
      idx,
      letter: TPO_LETTERS[idx % TPO_LETTERS.length]!,
      lo,
      hi,
      open: Math.floor(b.o / rt),
      close: Math.floor(b.c / rt),
    });
    for (let r = lo; r <= hi; r++) {
      let l = cur.rows.get(r);
      if (!l) cur.rows.set(r, (l = []));
      l.push(idx);
    }
    cur.end = b.tEnd;
    cur.close = Math.floor(b.c / rt);
  }
  if (cur) finish(cur, opts.valueAreaPct ?? 0.7, ib);
  return out;
}

function finish(p: TpoProfile, vaPct: number, ibPeriods: number): void {
  const levels = new Map<number, ProfileLevel>();
  let total = 0;
  for (const [r, l] of p.rows) {
    levels.set(r, { vol: l.length, buy: 0, sell: 0 });
    total += l.length;
    if (r < p.lo) p.lo = r;
    if (r > p.hi) p.hi = r;
  }
  p.total = total;
  // POC: most TPOs; ties go to the row closest to the profile centre, then the lower row.
  const mid = (p.lo + p.hi) / 2;
  let best = Number.NaN;
  let bestN = -1;
  for (const [r, l] of p.rows) {
    const n = l.length;
    if (
      n > bestN ||
      (n === bestN &&
        (Math.abs(r - mid) < Math.abs(best - mid) ||
          (Math.abs(r - mid) === Math.abs(best - mid) && r < best)))
    ) {
      best = r;
      bestN = n;
    }
  }
  p.poc = best;
  p.maxCount = Math.max(0, bestN);
  const va = valueArea(levels, best, p.lo, p.hi, total, vaPct);
  p.vah = va.vah;
  p.val = va.val;
  for (const per of p.periods.slice(0, ibPeriods)) {
    if (per.lo < p.ibLo) p.ibLo = per.lo;
    if (per.hi > p.ibHi) p.ibHi = per.hi;
  }
  p.singles =
    p.periods.length > 1
      ? [...p.rows]
          .filter(([, l]) => l.length === 1)
          .map(([r]) => r)
          .sort((a, b) => a - b)
      : [];
}
