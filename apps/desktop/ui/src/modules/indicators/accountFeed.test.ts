import { describe, expect, it } from 'vitest';
import { OrderBook } from '@htflow/market-data';
import { PaperEngine } from '@htflow/trading';
import { buildAccountSnapshot } from './accountFeed';

function setup() {
  const book = new OrderBook();
  book.applySnapshot({ ts: 0, bids: [[9999, 50]], asks: [[10000, 50]] });
  const paper = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.01, tickValue: 10 }),
    now: () => 1_000,
  });
  paper.createAccount({ id: 'A', name: 'Paper A', startingBalance: 10_000 });
  const deps = {
    paper,
    accountFor: () => 'A',
    economics: () => ({ tickSize: 0.01, tickValue: 10 }),
    last: () => 10_010 as number | undefined,
  };
  return { paper, deps };
}

describe('buildAccountSnapshot', () => {
  it('is read-only and reports balance, flat position and tick value', () => {
    const { paper, deps } = setup();
    const v0 = paper.version;
    const s = buildAccountSnapshot(deps, 'X')!;
    expect(s).toMatchObject({
      name: 'Paper A',
      balance: 10_000,
      startingBalance: 10_000,
      positionQty: 0,
      pnlPerTick: 10,
      otherUnrealized: 0,
      openPositions: 0,
    });
    expect(paper.version).toBe(v0);
    expect(paper.allPositions()).toHaveLength(0); // nothing was created by reading
  });

  it('splits the chart position from the other open positions', () => {
    const { paper, deps } = setup();
    paper.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 2 });
    paper.place({ accountId: 'A', instrumentId: 'Y', side: 'buy', type: 'market', qty: 1 });
    const s = buildAccountSnapshot(deps, 'X')!;
    expect(s.positionQty).toBe(2);
    expect(s.avgPx).toBe(10_000);
    expect(s.openPositions).toBe(2);
    // Y: bought at 10000, marked at 10010 -> 10 ticks x 10 per tick x 1 unit
    expect(s.otherUnrealized).toBeCloseTo(100, 9);
  });

  it('lists open option positions on the chart instrument only', () => {
    const { paper, deps } = setup();
    const base = {
      accountId: 'A',
      right: 'call' as const,
      expiry: '2027-03-26',
      side: 'buy' as const,
    };
    paper.tradeOption({ ...base, underlyingId: 'X', strike: 100, qty: 1, premium: 5 });
    paper.tradeOption({ ...base, underlyingId: 'Z', strike: 100, qty: 1, premium: 5 });
    const s = buildAccountSnapshot(deps, 'X')!;
    expect(s.options).toHaveLength(1);
    expect(s.options![0]).toMatchObject({ strike: 100, qty: 1, avgPremium: 5, right: 'call' });
    expect(s.openPositions).toBe(1);
  });

  it('returns null for an unknown account', () => {
    const { deps } = setup();
    expect(buildAccountSnapshot({ ...deps, accountFor: () => 'nope' }, 'X')).toBeNull();
  });
});
