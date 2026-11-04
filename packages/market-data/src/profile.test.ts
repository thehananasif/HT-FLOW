import { describe, expect, it } from 'vitest';
import { BarSeries } from './aggregator';
import { buildProfile } from './profile';
import type { Trade } from './types';

describe('volume profile', () => {
  it('computes POC and 70% value area by neighbour expansion', () => {
    const vols: Record<number, number> = { 10: 5, 11: 10, 12: 30, 13: 20, 14: 15, 15: 20 };
    const trades: Trade[] = Object.entries(vols).map(([px, q], i) => ({
      ts: i,
      px: Number(px),
      qty: q,
      side: i % 2 ? 'buy' : 'sell',
      id: i,
    }));
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades);
    const p = buildProfile(s.bars, 0, 0);
    expect(p.total).toBe(100);
    expect(p.poc).toBe(12);
    // 30 (12) -> +20 (13) -> 50; up 14=15 vs down 11=10 -> 65; up 15=20 vs down 11=10 -> 85 >= 70
    expect(p.val).toBe(12);
    expect(p.vah).toBe(15);
  });
});
