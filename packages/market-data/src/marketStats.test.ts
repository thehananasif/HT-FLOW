import { describe, expect, it } from 'vitest';
import { MarketStore } from './marketStore';
import { MOCK_INSTRUMENTS } from './instruments';
import type { FundingStat, LiquidationStat, OpenInterestStat } from './types';

describe('MarketStore derivatives stats', () => {
  it('keeps the latest funding / OI and notifies the onFunding / onOpenInterest / onLiquidation hooks', () => {
    const s = new MarketStore(MOCK_INSTRUMENTS[0]!.instrument);
    s.loadHistory({ trades: [], depth: [], book: { ts: 0, bids: [], asks: [] }, end: 0 });
    const funding: FundingStat[] = [];
    const oi: OpenInterestStat[] = [];
    const liq: LiquidationStat[][] = [];
    const off = s.onFunding((f) => funding.push(f));
    s.onOpenInterest((o) => oi.push(o));
    s.onLiquidation((l) => liq.push(l));
    s.ingest({
      ts: 10,
      trades: [],
      deltas: [],
      stats: [
        { kind: 'funding', ts: 10, rate: 0.0001, nextTs: 100, markPrice: 5 },
        { kind: 'open_interest', ts: 10, oi: 1234, value: Number.NaN },
        { kind: 'liquidation', ts: 10, side: 'sell', px: 50, qty: 2 },
        { kind: 'liquidation', ts: 11, side: 'buy', px: 51, qty: 1 },
      ],
    });
    expect(s.funding?.rate).toBe(0.0001);
    expect(s.openInterest?.oi).toBe(1234);
    expect(s.liquidations).toHaveLength(2);
    expect(funding).toHaveLength(1);
    expect(oi).toHaveLength(1);
    expect(liq).toEqual([[s.liquidations[0], s.liquidations[1]]]);
    off();
    s.ingest({
      ts: 12,
      trades: [],
      deltas: [],
      stats: [{ kind: 'funding', ts: 12, rate: -0.0002, nextTs: 100, markPrice: 5 }],
    });
    expect(funding).toHaveLength(1);
    expect(s.funding?.rate).toBe(-0.0002);
  });
});
