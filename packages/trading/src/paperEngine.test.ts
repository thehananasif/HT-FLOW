import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import { PaperEngine } from './paperEngine';
import { journalStats, roundTrips } from './journal';

function setup(tickValue = 10) {
  const book = new OrderBook();
  book.applySnapshot({
    ts: 0,
    bids: [
      [9999, 5],
      [9998, 10],
    ],
    asks: [
      [10000, 3],
      [10001, 10],
    ],
  });
  let t = 0;
  const eng = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.01, tickValue }),
    now: () => ++t,
  });
  eng.createAccount({ id: 'A', name: 'Paper', startingBalance: 10_000, commissionPerUnit: 2 });
  return { eng, book };
}

const trade = (px: number, side: 'buy' | 'sell' = 'buy'): Trade => ({
  ts: 0,
  px,
  qty: 1,
  side,
  id: 0,
});

describe('PaperEngine', () => {
  it('market orders walk the book (partial levels) and track average price', () => {
    const { eng } = setup();
    const o = eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 5 });
    expect(o.status).toBe('filled');
    expect(o.avgFillPx).toBeCloseTo((3 * 10000 + 2 * 10001) / 5);
    expect(eng.position('A', 'X').qty).toBe(5);
    expect(eng.accounts.get('A')!.balance).toBe(10_000 - 10); // commission 5 × 2
  });

  it('rests passive limits until the tape trades through, then books PnL by hand calculation', () => {
    const { eng } = setup();
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 2 }); // 2 @ 10000
    const lim = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'limit',
      px: 10010,
      qty: 2,
    });
    expect(lim.status).toBe('working');
    eng.onTrade('X', trade(10010));
    expect(lim.status).toBe('working'); // at price, not through
    eng.onTrade('X', trade(10011));
    expect(lim.status).toBe('filled');
    // 10 ticks × $10 × 2 = $200 realized; commissions 4 × $2 = $8
    expect(eng.position('A', 'X').realized).toBe(200);
    expect(eng.accounts.get('A')!.balance).toBe(10_000 + 200 - 8);
  });

  it('bracket with 3 targets: targets fill in sequence and the stop shrinks then disappears', () => {
    const { eng } = setup();
    const entry = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'market',
      qty: 3,
      bracket: { slTicks: 8, tpTicks: [4, 8, 12] },
    });
    expect(entry.avgFillPx).toBe(10000);
    const working = eng.workingOrders('A', 'X');
    expect(working.map((o) => [o.role, o.type, o.px ?? o.stopPx, o.qty])).toEqual([
      ['sl', 'stop', 9992, 3],
      ['tp', 'limit', 10004, 1],
      ['tp', 'limit', 10008, 1],
      ['tp', 'limit', 10012, 1],
    ]);
    eng.onTrade('X', trade(10005));
    expect(eng.workingOrders('A', 'X').find((o) => o.role === 'sl')!.qty).toBe(2);
    eng.onTrade('X', trade(10009));
    eng.onTrade('X', trade(10013));
    expect(eng.workingOrders('A', 'X')).toHaveLength(0);
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.position('A', 'X').realized).toBe((4 + 8 + 12) * 10);
  });

  it('stop fills cancel remaining targets; reduce-only and lock are enforced', () => {
    const { eng, book } = setup();
    eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'market',
      qty: 2,
      bracket: { slTicks: 5, tpTicks: [10] },
    });
    book.applyDelta({ side: 'buy', px: 9995, qty: 50 });
    eng.onTrade('X', trade(9995, 'sell'));
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.workingOrders('A', 'X')).toHaveLength(0);
    const ro = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'market',
      qty: 1,
      reduceOnly: true,
    });
    expect(ro.status).toBe('rejected');
    eng.setLocked('A', true);
    expect(
      eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 1 }).status,
    ).toBe('rejected');
  });

  it('reverse and breakeven', () => {
    const { eng } = setup();
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 2 });
    eng.breakeven('A', 'X');
    expect(eng.workingOrders('A', 'X')[0]).toMatchObject({
      type: 'stop',
      stopPx: 10000,
      side: 'sell',
    });
    eng.reverse('A', 'X');
    expect(eng.position('A', 'X').qty).toBe(-2);
  });

  it('journal groups FIFO round trips and computes stats', () => {
    const { eng } = setup(0);
    for (let i = 0; i < 10; i++) {
      eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 1 });
      const exit = i % 2 === 0 ? 10010 : 9990;
      eng.place({
        accountId: 'A',
        instrumentId: 'X',
        side: 'sell',
        type: 'limit',
        px: exit,
        qty: 1,
      });
      eng.onTrade('X', trade(i % 2 === 0 ? exit + 1 : exit + 1));
      if (eng.position('A', 'X').qty !== 0) eng.flatten('A', 'X');
    }
    const trips = roundTrips(eng.fills, () => 0.01);
    expect(trips).toHaveLength(10);
    const s = journalStats(trips);
    expect(s.trades).toBe(10);
    expect(s.wins + s.losses).toBe(10);
    expect(s.netPnl).toBeCloseTo(
      trips.reduce((a, t) => a + t.pnl - t.commission, 0),
      9,
    );
  });
});
