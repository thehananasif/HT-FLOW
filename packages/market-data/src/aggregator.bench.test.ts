import { describe, expect, it } from 'vitest';
import { BarSeries, type TradeColumns } from './aggregator';

/** Deterministic random-walk ticks (~5 h of a busy market at 10M prints). */
export function syntheticTicks(n: number, seed = 1): TradeColumns {
  const ts = new Float64Array(n);
  const px = new Int32Array(n);
  const qty = new Float64Array(n);
  const side = new Int8Array(n);
  let s = seed >>> 0;
  let p = 100_000;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const r = s / 4294967296;
    if (r < 0.2) p--;
    else if (r > 0.8) p++;
    t += (s & 3) + 0.5;
    ts[i] = t;
    px[i] = p;
    qty[i] = 1 + (s & 7);
    side[i] = r < 0.5 ? -1 : 1;
  }
  return { ts, px, qty, side };
}

describe('aggregation benchmark (P07 acceptance)', () => {
  it('10M ticks into M1 cluster bars', () => {
    const N = 10_000_000;
    const cols = syntheticTicks(N);
    const runs: number[] = [];
    let bars = 0;
    for (let r = 0; r < 3; r++) {
      const s = new BarSeries({ kind: 'time', ms: 60_000 });
      const t0 = performance.now();
      s.addColumns(cols);
      runs.push(performance.now() - t0);
      bars = s.bars.length;
      let vol = 0;
      for (const b of s.bars) vol += b.vol;
      expect(vol).toBeGreaterThan(N);
    }
    const best = Math.min(...runs);
    console.info(
      `[bench] 10M ticks → ${bars} M1 cluster bars: best ${best.toFixed(0)} ms, runs ${runs.map((x) => x.toFixed(0)).join(' / ')} ms`,
    );
    // Target < 1 s; the assertion leaves headroom for slow / shared CI machines.
    expect(best).toBeLessThan(3000);
  }, 60_000);
});
