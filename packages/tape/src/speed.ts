export interface SpeedReading {
  printsPerSec: number;
  volPerSec: number;
}

/**
 * Prints/sec and volume/sec over a trailing window, using fixed time buckets so that adding a
 * print and reading the rate are O(1) / O(buckets) regardless of the print rate.
 */
export class SpeedMeter {
  private readonly n: number;
  private readonly keys: Float64Array;
  private readonly counts: Float64Array;
  private readonly vols: Float64Array;

  constructor(
    readonly windowMs = 1000,
    readonly bucketMs = 100,
  ) {
    this.n = Math.max(1, Math.ceil(windowMs / bucketMs));
    this.keys = new Float64Array(this.n).fill(-1);
    this.counts = new Float64Array(this.n);
    this.vols = new Float64Array(this.n);
  }

  reset(): void {
    this.keys.fill(-1);
  }

  add(ts: number, qty: number, prints = 1): void {
    const k = Math.floor(ts / this.bucketMs);
    const i = k % this.n;
    if (this.keys[i] !== k) {
      this.keys[i] = k;
      this.counts[i] = 0;
      this.vols[i] = 0;
    }
    this.counts[i]! += prints;
    this.vols[i]! += qty;
  }

  /** Rate over the window ending at `now` (buckets (now − window, now]). */
  rate(now: number): SpeedReading {
    const kNow = Math.floor(now / this.bucketMs);
    let c = 0;
    let v = 0;
    for (let i = 0; i < this.n; i++) {
      const k = this.keys[i]!;
      if (k > kNow - this.n && k <= kNow) {
        c += this.counts[i]!;
        v += this.vols[i]!;
      }
    }
    const secs = (this.n * this.bucketMs) / 1000;
    return { printsPerSec: c / secs, volPerSec: v / secs };
  }
}
