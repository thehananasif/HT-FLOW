import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import { PaperEngine } from './paperEngine';

function setup() {
  const book = new OrderBook();
  book.applySnapshot({
    ts: 0,
    bids: [[9999, 50]],
    asks: [[10000, 50]],
  });
  const eng = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.01, tickValue: 10 }),
    now: () => 777, // wall clock stand-in
  });
  eng.createAccount({ id: 'A', name: 'Paper', startingBalance: 10_000, commissionPerUnit: 0 });
  return eng;
}

const trade = (px: number): Trade => ({ ts: 0, px, qty: 5, side: 'sell', id: 1 });

describe('PaperEngine per-instrument clock (replay)', () => {
  it('stamps orders and fills of clocked instruments with the injected time only', () => {
    const eng = setup();
    let replayTime = 1_700_000_000_000;
    eng.setClock((id) => (id.startsWith('replay:') ? replayTime : undefined));
    const live = eng.place({
      accountId: 'A',
      instrumentId: 'live:X',
      side: 'buy',
      type: 'market',
      qty: 1,
    });
    const rep = eng.place({
      accountId: 'A',
      instrumentId: 'replay:X',
      side: 'buy',
      type: 'market',
      qty: 1,
    });
    expect(live.createdAt).toBe(777);
    expect(rep.createdAt).toBe(replayTime);
    const fills = eng.fills.filter((f) => f.instrumentId === 'replay:X');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.ts).toBe(replayTime);
    expect(eng.fills.find((f) => f.instrumentId === 'live:X')!.ts).toBe(777);
    // a resting limit filled later by the tape is stamped with the replay time of that moment
    const lim = eng.place({
      accountId: 'A',
      instrumentId: 'replay:X',
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 1,
    });
    replayTime += 90_000;
    eng.onTrade('replay:X', trade(9989));
    expect(lim.status).toBe('filled');
    const lf = eng.fills.filter((f) => f.orderId === lim.id);
    expect(lf[0]!.ts).toBe(replayTime);
    // cancel is stamped too
    const rest = eng.place({
      accountId: 'A',
      instrumentId: 'replay:X',
      side: 'sell',
      type: 'limit',
      px: 10100,
      qty: 1,
    });
    replayTime += 1000;
    eng.cancel(rest.id);
    expect(rest.updatedAt).toBe(replayTime);
  });

  it('clearing the clock restores wall time', () => {
    const eng = setup();
    eng.setClock(() => 5);
    eng.setClock(null);
    const o = eng.place({
      accountId: 'A',
      instrumentId: 'replay:X',
      side: 'buy',
      type: 'market',
      qty: 1,
    });
    expect(o.createdAt).toBe(777);
  });
});
