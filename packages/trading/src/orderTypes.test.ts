import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import { PaperEngine, splitQty } from './paperEngine';
import { visibleQty } from './types';

function setup(opts: { tickValue?: number; atr?: number; last?: number } = {}) {
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
    economics: () => ({ tickSize: 0.01, tickValue: opts.tickValue ?? 10 }),
    now: () => ++t,
    atr: opts.atr !== undefined ? () => opts.atr : undefined,
    last: opts.last !== undefined ? () => opts.last : undefined,
  });
  eng.createAccount({ id: 'A', name: 'Paper', startingBalance: 10_000 });
  return { eng, book };
}

const trade = (px: number, qty = 1): Trade => ({ ts: 0, px, qty, side: 'buy', id: 0 });
const base = { accountId: 'A', instrumentId: 'X' } as const;

describe('iceberg', () => {
  it('shows only the display quantity and refills one slice per trade-through', () => {
    const { eng } = setup();
    const o = eng.place({ ...base, side: 'buy', type: 'limit', px: 9990, qty: 5, displayQty: 2 });
    expect(o.status).toBe('working');
    expect(visibleQty(o)).toBe(2);
    eng.onTrade('X', trade(9989));
    expect(o.filled).toBe(2);
    expect(o.refills).toBe(1);
    expect(visibleQty(o)).toBe(2);
    eng.onTrade('X', trade(9990)); // at price, not through: no fill
    expect(o.filled).toBe(2);
    eng.onTrade('X', trade(9989));
    eng.onTrade('X', trade(9989));
    expect(o.filled).toBe(5);
    expect(o.status).toBe('filled');
    expect(o.refills).toBe(2);
    expect(eng.position('A', 'X')).toMatchObject({ qty: 5, avgPx: 9990 });
    expect(eng.fills.map((f) => f.qty)).toEqual([2, 2, 1]);
    expect(eng.fills.every((f) => f.liquidity === 'maker')).toBe(true);
  });

  it('rejects icebergs on non-limit orders and invalid display quantities', () => {
    const { eng } = setup();
    expect(
      eng.place({ ...base, side: 'buy', type: 'stop', stopPx: 10010, qty: 5, displayQty: 1 })
        .reason,
    ).toBe('Iceberg needs a limit order');
    expect(
      eng.place({ ...base, side: 'buy', type: 'limit', px: 9990, qty: 5, displayQty: 0 }).reason,
    ).toBe('Display quantity must be > 0');
    // A display quantity >= total is a plain limit.
    const plain = eng.place({
      ...base,
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 2,
      displayQty: 3,
    });
    expect(plain.displayQty).toBeUndefined();
  });

  it('a marketable iceberg takes liquidity for its full size', () => {
    const { eng } = setup();
    const o = eng.place({ ...base, side: 'buy', type: 'limit', px: 10001, qty: 5, displayQty: 1 });
    expect(o.status).toBe('filled');
    expect(o.avgFillPx).toBeCloseTo((3 * 10000 + 2 * 10001) / 5);
  });
});

describe('MIT', () => {
  it('buy MIT triggers when price touches at or below the trigger and fills at market', () => {
    const { eng } = setup();
    const o = eng.place({ ...base, side: 'buy', type: 'mit', stopPx: 9995, qty: 1 });
    expect(o.status).toBe('working');
    eng.onTrade('X', trade(9996));
    expect(o.status).toBe('working');
    eng.onTrade('X', trade(9995));
    expect(o.status).toBe('filled');
    expect(o.type).toBe('market');
    expect(eng.position('A', 'X').qty).toBe(1);
  });

  it('sell MIT triggers at or above the trigger; missing trigger is rejected', () => {
    const { eng } = setup();
    const o = eng.place({ ...base, side: 'sell', type: 'mit', stopPx: 10005, qty: 2 });
    eng.onTrade('X', trade(10004));
    expect(o.status).toBe('working');
    eng.onTrade('X', trade(10007));
    expect(o.status).toBe('filled');
    expect(eng.position('A', 'X').qty).toBe(-2);
    expect(eng.place({ ...base, side: 'buy', type: 'mit', qty: 1 }).reason).toBe(
      'Trigger price required',
    );
  });
});

describe('trailing stop', () => {
  it('ticks: follows the high, never loosens, triggers on the pullback', () => {
    const { eng } = setup({ last: 10000 });
    eng.place({ ...base, side: 'buy', type: 'market', qty: 1 });
    const ts = eng.place({
      ...base,
      side: 'sell',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'ticks', amount: 5 },
    });
    expect(ts.stopPx).toBe(9995);
    eng.onTrade('X', trade(10010));
    expect(ts.stopPx).toBe(10005);
    eng.onTrade('X', trade(10007)); // pullback inside the trail: stop stays
    expect(ts.stopPx).toBe(10005);
    expect(ts.status).toBe('working');
    eng.onTrade('X', trade(10005));
    expect(ts.status).toBe('filled');
    expect(eng.position('A', 'X').qty).toBe(0);
  });

  it('percent: distance is a percentage of the best price', () => {
    const { eng } = setup({ last: 10000 });
    const ts = eng.place({
      ...base,
      side: 'buy',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'percent', amount: 0.1 }, // 0.1 % of 10000 ticks = 10 ticks
    });
    expect(ts.stopPx).toBe(10010);
    eng.onTrade('X', trade(9980));
    expect(ts.stopPx).toBe(9990); // 0.1 % of 9980 = 9.98 → 10 ticks
    eng.onTrade('X', trade(9991));
    expect(ts.status).toBe('filled');
  });

  it('ATR: uses the live ATR, falls back to the captured value, rejects when unknown', () => {
    const live = setup({ atr: 4, last: 10000 });
    const a = live.eng.place({
      ...base,
      side: 'sell',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'atr', amount: 2 },
    });
    expect(a.stopPx).toBe(10000 - 8);
    const captured = setup({ last: 10000 });
    const b = captured.eng.place({
      ...base,
      side: 'sell',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'atr', amount: 1.5, atrTicks: 6 },
    });
    expect(b.stopPx).toBe(10000 - 9);
    const none = captured.eng.place({
      ...base,
      side: 'sell',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'atr', amount: 2 },
    });
    expect(none.status).toBe('rejected');
  });

  it('dragging a trailing stop keeps trailing from the new level', () => {
    const { eng } = setup({ last: 10000 });
    const ts = eng.place({
      ...base,
      side: 'sell',
      type: 'trailing-stop',
      qty: 1,
      trail: { kind: 'ticks', amount: 5 },
    });
    eng.modify(ts.id, { stopPx: 9990 }); // looser by 5
    eng.onTrade('X', trade(10003));
    expect(ts.stopPx).toBe(9993); // reference moved with the drag (distance now 10)
  });

  it('applies slippage ticks to triggered stops only', () => {
    const { eng, book } = setup({ last: 10000 });
    eng.updateAccount('A', { slippageTicks: 2 });
    book.applySnapshot({ ts: 1, bids: [], asks: [] }); // empty book: fill at the trade price
    const s = eng.place({ ...base, side: 'buy', type: 'stop', stopPx: 10005, qty: 1 });
    eng.onTrade('X', trade(10005));
    expect(s.avgFillPx).toBe(10007);
  });
});

describe('stop-limit', () => {
  it('becomes a limit at the trigger and rests when the book is beyond the limit', () => {
    const { eng, book } = setup();
    const o = eng.place({
      ...base,
      side: 'buy',
      type: 'stop-limit',
      stopPx: 10002,
      px: 10003,
      qty: 2,
    });
    eng.onTrade('X', trade(10001));
    expect(o.type).toBe('stop-limit');
    book.applySnapshot({
      ts: 1,
      bids: [[10002, 5]],
      asks: [
        [10004, 1],
        [10005, 5],
      ],
    });
    eng.onTrade('X', trade(10002));
    expect(o.type).toBe('limit');
    expect(o.status).toBe('working'); // ask 10004 > limit 10003
    eng.onTrade('X', trade(10002)); // limit 10003: buy fills when the tape trades below
    expect(o.status).toBe('filled');
    expect(o.avgFillPx).toBe(10003);
  });

  it('fills immediately at the limit or better when the book allows', () => {
    const { eng } = setup();
    const o = eng.place({
      ...base,
      side: 'sell',
      type: 'stop-limit',
      stopPx: 9999,
      px: 9998,
      qty: 3,
    });
    eng.onTrade('X', trade(9999));
    expect(o.status).toBe('filled');
    expect(o.avgFillPx).toBeCloseTo((5 * 0 + 3 * 9999) / 3);
  });

  it('requires both prices', () => {
    const { eng } = setup();
    expect(eng.place({ ...base, side: 'buy', type: 'stop-limit', px: 1, qty: 1 }).reason).toBe(
      'Stop price required',
    );
    expect(eng.place({ ...base, side: 'buy', type: 'stop-limit', stopPx: 1, qty: 1 }).reason).toBe(
      'Limit price required',
    );
  });
});

describe('maker / taker fees', () => {
  it('charges the maker fee on passive fills and the taker fee on aggressive fills', () => {
    const { eng } = setup({ tickValue: 0 }); // linear: notional = px × tickSize × qty
    eng.updateAccount('A', { takerFee: 0.0005, makerFee: 0.0002 });
    eng.place({ ...base, side: 'buy', type: 'market', qty: 1 }); // 1 @ 10000 → $100 notional
    const lim = eng.place({ ...base, side: 'sell', type: 'limit', px: 10010, qty: 1 });
    eng.onTrade('X', trade(10011));
    expect(lim.status).toBe('filled');
    const [taker, maker] = eng.fills;
    expect(taker!.liquidity).toBe('taker');
    expect(taker!.commission).toBeCloseTo(100 * 0.0005, 10);
    expect(maker!.liquidity).toBe('maker');
    expect(maker!.commission).toBeCloseTo(100.1 * 0.0002, 10);
  });

  it('negative maker fee is a rebate; undefined maker fee falls back to the taker rate', () => {
    const { eng } = setup({ tickValue: 0 });
    eng.updateAccount('A', { takerFee: 0.001, makerFee: -0.0001 });
    eng.place({ ...base, side: 'buy', type: 'limit', px: 9990, qty: 1 });
    eng.onTrade('X', trade(9989));
    expect(eng.fills[0]!.commission).toBeCloseTo(-99.9 * 0.0001, 10);
    const legacy = setup({ tickValue: 0 }).eng;
    legacy.updateAccount('A', { takerFee: 0.001 });
    legacy.place({ ...base, side: 'buy', type: 'limit', px: 9990, qty: 1 });
    legacy.onTrade('X', trade(9989));
    expect(legacy.fills[0]!.commission).toBeCloseTo(99.9 * 0.001, 10);
  });

  it('per-unit commission applies to maker and taker fills alike (futures)', () => {
    const { eng } = setup();
    eng.updateAccount('A', { commissionPerUnit: 2.5 });
    eng.place({ ...base, side: 'buy', type: 'market', qty: 2 });
    eng.place({ ...base, side: 'sell', type: 'limit', px: 10010, qty: 2 });
    eng.onTrade('X', trade(10011));
    expect(eng.fills.map((f) => f.commission)).toEqual([5, 5]);
  });
});

describe('paper accounts', () => {
  it('create, rename, set starting balance + currency, reset and delete', () => {
    const { eng } = setup();
    eng.createAccount({ id: 'B', name: 'Second', startingBalance: 25_000, currency: 'EUR' });
    expect(eng.accounts.get('B')).toMatchObject({ balance: 25_000, currency: 'EUR' });
    expect(eng.renameAccount('B', '  Swing  ')).toBe(true);
    expect(eng.accounts.get('B')!.name).toBe('Swing');
    expect(eng.renameAccount('B', '   ')).toBe(false);
    eng.place({ accountId: 'B', instrumentId: 'X', side: 'buy', type: 'market', qty: 1 });
    eng.place({ accountId: 'B', instrumentId: 'X', side: 'buy', type: 'limit', px: 9000, qty: 1 });
    expect(eng.setStartingBalance('B', 100_000, 'USD')).toBe(true);
    const b = eng.accounts.get('B')!;
    expect(b).toMatchObject({ startingBalance: 100_000, balance: 100_000, currency: 'USD' });
    expect(eng.position('B', 'X').qty).toBe(0);
    expect(eng.workingOrders('B')).toHaveLength(0);
    expect(eng.setStartingBalance('B', -1)).toBe(false);
    eng.place({ accountId: 'B', instrumentId: 'X', side: 'buy', type: 'market', qty: 1 });
    expect(eng.deleteAccount('B')).toBe(true);
    expect(eng.accounts.has('B')).toBe(false);
    expect(eng.allPositions('B')).toHaveLength(0);
    expect(eng.deleteAccount('B')).toBe(false);
    // Account A is untouched.
    expect(eng.accounts.get('A')!.balance).toBe(10_000);
  });

  it('accounts are isolated from each other', () => {
    const { eng } = setup();
    eng.createAccount({ id: 'B', name: 'B' });
    eng.place({ ...base, side: 'buy', type: 'market', qty: 1 });
    expect(eng.position('B', 'X').qty).toBe(0);
    eng.resetAccount('A');
    expect(eng.position('A', 'X').qty).toBe(0);
  });
});

describe('ATM bracket management', () => {
  it('splits targets by weight and attaches a trailing stop-loss', () => {
    const { eng } = setup();
    eng.place({
      ...base,
      side: 'buy',
      type: 'market',
      qty: 3,
      bracket: {
        slTicks: 6,
        slTrail: { kind: 'ticks', amount: 6 },
        tpTicks: [4, 10],
        tpQty: [1, 2],
        atm: 'Test',
      },
    });
    const w = eng.workingOrders('A', 'X');
    const sl = w.find((o) => o.role === 'sl')!;
    expect(sl).toMatchObject({ type: 'trailing-stop', stopPx: 9994, qty: 3, atm: 'Test' });
    expect(w.filter((o) => o.role === 'tp').map((o) => [o.px, o.qty])).toEqual([
      [10004, 1],
      [10010, 2],
    ]);
    eng.onTrade('X', trade(10003));
    expect(sl.stopPx).toBe(9997);
  });

  it('auto-breakeven moves the stop to entry + offset once, never back', () => {
    const { eng } = setup();
    eng.place({
      ...base,
      side: 'buy',
      type: 'market',
      qty: 1,
      bracket: { slTicks: 10, tpTicks: [40], breakeven: { trigger: 8, offset: 1 } },
    });
    const sl = eng.workingOrders('A', 'X').find((o) => o.role === 'sl')!;
    eng.onTrade('X', trade(10007));
    expect(sl.stopPx).toBe(9990);
    eng.onTrade('X', trade(10008));
    expect(sl.stopPx).toBe(10001);
    eng.onTrade('X', trade(10004));
    expect(sl.stopPx).toBe(10001);
    const entry = eng.fills[0]!.orderId;
    expect(eng.bracketState(entry)).toEqual({ breakevenDone: true });
  });

  it('trailing steps ratchet the stop for a short position', () => {
    const { eng, book } = setup();
    eng.place({
      ...base,
      side: 'sell',
      type: 'market',
      qty: 1, // 1 @ 9999
      bracket: {
        slTicks: 10,
        trailSteps: [
          { trigger: 20, stopOffset: 10 },
          { trigger: 10, stopOffset: 2 },
        ],
      },
    });
    const sl = eng.workingOrders('A', 'X').find((o) => o.role === 'sl')!;
    expect(sl.stopPx).toBe(10009);
    eng.onTrade('X', trade(9989)); // +10
    expect(sl.stopPx).toBe(9997);
    eng.onTrade('X', trade(9979)); // +20
    expect(sl.stopPx).toBe(9989);
    book.applySnapshot({ ts: 1, bids: [[9988, 5]], asks: [[9989, 5]] });
    eng.onTrade('X', trade(9989)); // stop hit at 9989
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.position('A', 'X').realized).toBe(10 * 10); // 9999 − 9989 = 10 ticks × $10
  });

  it('a limit entry attaches its bracket on fill and dragging the entry modifies it', () => {
    const { eng } = setup();
    const o = eng.place({
      ...base,
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 2,
      bracket: { slTicks: 5, tpTicks: [5] },
    });
    expect(eng.modify(o.id, { px: 9985 })).toBe(true);
    expect(o.px).toBe(9985);
    expect(eng.workingOrders('A', 'X')).toHaveLength(1);
    expect(eng.modify(o.id, { px: 10001 })).toBe(true); // dragged through the ask: fills
    expect(o.status).toBe('filled');
    const kids = eng.workingOrders('A', 'X');
    expect(kids.map((k) => k.role).sort()).toEqual(['sl', 'tp']);
    expect(eng.modify(o.id, { px: 1 })).toBe(false);
    expect(eng.modify(kids[0]!.id, { qty: 0 })).toBe(false);
  });
});

describe('splitQty', () => {
  it('keeps whole lots whole and sums to the total', () => {
    expect(splitQty(5, [1, 1, 1], 3)).toEqual([2, 2, 1]);
    expect(splitQty(4, [1, 3], 2)).toEqual([1, 3]);
    expect(splitQty(1, [1, 1], 2)).toEqual([1, 0]);
    const f = splitQty(0.3, [1, 2], 2);
    expect(f[0]! + f[1]!).toBeCloseTo(0.3);
    expect(splitQty(3, undefined, 3)).toEqual([1, 1, 1]);
  });
});

describe('options (minimal model)', () => {
  it('opens long and short, marks to model, closes with realized PnL and expires', () => {
    const { eng } = setup();
    eng.updateAccount('A', { commissionPerUnit: 1 });
    const p = eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'call',
      strike: 100,
      expiry: '2026-12-18',
      side: 'buy',
      qty: 2,
      premium: 3,
      multiplier: 100,
    });
    if (typeof p === 'string') throw new Error(p);
    expect(eng.premiumFlow(p)).toBe(600); // debit
    expect(eng.accounts.get('A')!.balance).toBe(10_000 - 2);
    eng.setOptionMarkModel(() => 4);
    eng.markOptions();
    expect(p.mark).toBe(4);
    expect(eng.optionUnrealized('A')).toBe(200);
    eng.tradeOption({ ...p, accountId: 'A', side: 'sell', qty: 1, premium: 5 });
    expect(p.qty).toBe(1);
    expect(p.realized).toBe(200);
    expect(eng.accounts.get('A')!.balance).toBe(10_000 - 2 + 200 - 1);
    eng.setOptionMarkModel(null);
    expect(eng.expireOption(p.id, 101.5)).toBe(true); // intrinsic 1.5 vs avg 3 → −150
    expect(p.qty).toBe(0);
    expect(eng.optionPositions('A')).toHaveLength(0);
    const short = eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'put',
      strike: 90,
      expiry: '2026-12-18',
      side: 'sell',
      qty: 1,
      premium: 2,
      multiplier: 100,
    });
    if (typeof short === 'string') throw new Error(short);
    expect(eng.premiumFlow(short)).toBe(-200); // credit
    expect(eng.tradeOption({ ...short, accountId: 'A', side: 'buy', qty: 0, premium: 1 })).toBe(
      'Quantity must be > 0',
    );
  });
});
