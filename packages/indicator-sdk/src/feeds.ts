import type {
  DepthColumn,
  FundingStat,
  LiquidationStat,
  OpenInterestStat,
} from '@htflow/market-data';

/**
 * Derivatives statistics an indicator can read (funding, open interest, liquidations). Arrays are
 * sorted by time and only ever appended to, so recomputing the last bar is deterministic.
 * Simulated / spot feeds leave them empty: indicators then report "no data from this feed".
 */
export interface DerivativesData {
  /** Bumped whenever a sample is added. */
  readonly version: number;
  readonly funding: readonly FundingStat[];
  readonly openInterest: readonly OpenInterestStat[];
  readonly liquidations: readonly LiquidationStat[];
}

/** Resting-depth columns (store.depth) sorted by time. */
export interface DepthData {
  readonly version: number;
  readonly columns: readonly DepthColumn[];
}

/** Index of the first element whose time is >= t (binary search). */
export function lowerBoundBy<T>(arr: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]!) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last element with time <= t (undefined when none). */
export function lastAtOrBefore<T>(
  arr: readonly T[],
  t: number,
  key: (x: T) => number,
): T | undefined {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? arr[lo - 1] : undefined;
}

/** Elements with from <= time <= to. */
export function between<T>(
  arr: readonly T[],
  from: number,
  to: number,
  key: (x: T) => number,
): T[] {
  const a = lowerBoundBy(arr, from, key);
  const out: T[] = [];
  for (let k = a; k < arr.length && key(arr[k]!) <= to; k++) out.push(arr[k]!);
  return out;
}

/** The parts of MarketStore the log listens to (structural, so tests can fake it). */
export interface DerivativesSource {
  funding: FundingStat | null;
  openInterest: OpenInterestStat | null;
  liquidations: LiquidationStat[];
  onFunding(fn: (f: FundingStat) => void): () => void;
  onOpenInterest(fn: (o: OpenInterestStat) => void): () => void;
  onLiquidation(fn: (l: LiquidationStat[]) => void): () => void;
}

const CAP = 50_000;

/**
 * Accumulates the derivatives events of one market store into time series (the store itself only
 * keeps the latest funding / OI). `attach` returns the disposer.
 */
export class DerivativesLog implements DerivativesData {
  version = 0;
  readonly funding: FundingStat[] = [];
  readonly openInterest: OpenInterestStat[] = [];
  readonly liquidations: LiquidationStat[] = [];

  addFunding(f: FundingStat): void {
    if (this.funding.length && f.ts < this.funding[this.funding.length - 1]!.ts) return;
    this.funding.push(f);
    this.trim(this.funding);
    this.version++;
  }

  addOpenInterest(o: OpenInterestStat): void {
    if (this.openInterest.length && o.ts < this.openInterest[this.openInterest.length - 1]!.ts)
      return;
    this.openInterest.push(o);
    this.trim(this.openInterest);
    this.version++;
  }

  addLiquidations(list: readonly LiquidationStat[]): void {
    let added = false;
    for (const l of list) {
      if (this.liquidations.length && l.ts < this.liquidations[this.liquidations.length - 1]!.ts)
        continue;
      this.liquidations.push(l);
      added = true;
    }
    if (added) {
      this.trim(this.liquidations);
      this.version++;
    }
  }

  private trim(a: unknown[]): void {
    if (a.length > CAP) a.splice(0, a.length - CAP);
  }

  attach(src: DerivativesSource): () => void {
    if (src.funding) this.addFunding(src.funding);
    if (src.openInterest) this.addOpenInterest(src.openInterest);
    this.addLiquidations(src.liquidations);
    const offs = [
      src.onFunding((f) => this.addFunding(f)),
      src.onOpenInterest((o) => this.addOpenInterest(o)),
      src.onLiquidation((l) => this.addLiquidations(l)),
    ];
    return () => offs.forEach((o) => o());
  }
}

/** One trader category of a weekly CFTC Commitments of Traders row. */
export interface CotGroupData {
  /** Stable key: commercial, noncommercial, nonreportable, producer, swap, managed, other, dealer, assetmgr, levmoney. */
  key: string;
  label: string;
  long: number;
  short: number;
  net: number;
  netChange: number;
}

/** One weekly report (positions as of Tuesday `t`, published the Friday after). */
export interface CotWeekData {
  /** Report date (Tuesday 00:00 UTC), ms. */
  t: number;
  openInterest: number;
  groups: readonly CotGroupData[];
}

/** Weekly COT history for the chart's instrument (undefined when the host has none yet). */
export interface CotData {
  /** Bumped when the rows change. */
  readonly version: number;
  readonly report: 'legacy' | 'disagg' | 'tff';
  readonly market: string;
  /** Oldest first. */
  readonly weeks: readonly CotWeekData[];
}

/** Ms after the Tuesday report date when the data became public (Friday 20:30 UTC). */
export const COT_RELEASE_LAG_MS = (3 * 24 + 20.5) * 3_600_000;

export const NO_FEED_NOTICE = 'no data from this feed';
