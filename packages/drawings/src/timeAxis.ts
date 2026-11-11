/**
 * Time ↔ slot mapping for slot-based x scales (bars, depth columns).
 *
 * Slot i covers [i − 0.5, i + 0.5] on screen (ChartCore puts slot centres at integers). A time inside
 * slot i maps linearly from its open time (left edge) to the next slot's open time (right edge).
 * Before the first slot and after the last slot the mapping extrapolates with the slot duration, so
 * drawings can extend into the future and survive timeframe / bar-type changes.
 */
export class TimeAxis {
  private cachedN = -1;
  private cachedLast = Number.NaN;
  private cachedDur = 60_000;

  constructor(
    readonly count: () => number,
    readonly timeAt: (i: number) => number,
    /** Nominal slot duration (time bars, depth columns); estimated from data when undefined. */
    readonly nominalMs: () => number | undefined = () => undefined,
  ) {}

  /** Slot duration used for extrapolation. */
  duration(): number {
    const nominal = this.nominalMs();
    if (nominal && nominal > 0) return nominal;
    const n = this.count();
    const last = n > 0 ? this.timeAt(n - 1) : Number.NaN;
    if (n === this.cachedN && last === this.cachedLast) return this.cachedDur;
    this.cachedN = n;
    this.cachedLast = last;
    if (n < 2) return (this.cachedDur = 60_000);
    const from = Math.max(0, n - 101);
    const spans: number[] = [];
    for (let i = from; i < n - 1; i++) {
      const d = this.timeAt(i + 1) - this.timeAt(i);
      if (d > 0) spans.push(d);
    }
    if (!spans.length) return (this.cachedDur = 1000);
    spans.sort((a, b) => a - b);
    return (this.cachedDur = Math.max(1, spans[spans.length >> 1]!));
  }

  /** Last slot whose open time is ≤ t (−1 when t is before the first slot). */
  indexAt(t: number): number {
    const n = this.count();
    if (n === 0 || t < this.timeAt(0)) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.timeAt(mid) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Fractional slot position of time t. */
  slotOf(t: number): number {
    const n = this.count();
    const d = this.duration();
    if (n === 0) return -0.5 + (t - Date.now()) / d;
    const t0 = this.timeAt(0);
    if (t < t0) return -0.5 + (t - t0) / d;
    const i = this.indexAt(t);
    const ti = this.timeAt(i);
    if (i >= n - 1) return i - 0.5 + (t - ti) / d;
    const span = this.timeAt(i + 1) - ti;
    return i - 0.5 + (span > 0 ? (t - ti) / span : 0);
  }

  /** Time at fractional slot s (inverse of slotOf). */
  timeOf(s: number): number {
    const n = this.count();
    const d = this.duration();
    if (n === 0) return Date.now() + (s + 0.5) * d;
    const i = Math.floor(s + 0.5);
    const f = s + 0.5 - i;
    if (i < 0) return this.timeAt(0) + (s + 0.5) * d;
    if (i >= n - 1) return this.timeAt(n - 1) + (s + 0.5 - (n - 1)) * d;
    const ti = this.timeAt(i);
    return ti + f * (this.timeAt(i + 1) - ti);
  }

  /** Time of the centre of slot i (what the magnet snaps to). */
  centreTime(i: number): number {
    return this.timeOf(i);
  }
}
