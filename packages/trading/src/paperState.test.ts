import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import { ocoGroupId, PaperEngine } from './paperEngine';
import { normalizeAccountState } from './persistState';
import { RiskEngine, defaultRiskRules } from './risk';

function setup(now = () => 1_000) {
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
  const eng = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.25, tickValue: 12.5 }),
    now,
  });
  eng.createAccount({ id: 'A', name: 'Paper', startingBalance: 10_000, commissionPerUnit: 1 });
  return { eng, book };
}

const trade = (px: number): Trade => ({ ts: 0, px, qty: 1, side: 'buy', id: 0 });

describe('user OCO groups', () => {
  it('a fill of one order cancels the other', () => {
    const { eng } = setup();
    const g = ocoGroupId();
    const buy = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 1,
      oco: g,
    });
    const stop = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'stop',
      stopPx: 10010,
      qty: 1,
      oco: g,
    });
    expect(buy.oco).toBe(g);
    expect(stop.status).toBe('working');
    eng.onTrade('X', trade(9989)); // trades through the buy limit
    expect(buy.status).toBe('filled');
    expect(stop.status).toBe('cancelled');
    expect(stop.reason).toBe('OCO sibling filled');
    expect(eng.position('A', 'X').qty).toBe(1);
  });

  it('cancelling one order cancels the other; a used group rejects new orders', () => {
    const { eng } = setup();
    const g = ocoGroupId();
    const a = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 1,
      oco: g,
    });
    const b = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'limit',
      px: 10020,
      qty: 1,
      oco: g,
    });
    expect(eng.cancel(a.id)).toBe(true);
    expect(b.status).toBe('cancelled');
    expect(b.reason).toBe('OCO sibling cancelled');
    const c = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'limit',
      px: 10030,
      qty: 1,
      oco: g,
    });
    expect(c.status).toBe('rejected');
  });

  it('a partial fill cancels the siblings; bracket groups keep their own rules', () => {
    const { eng } = setup();
    const g = ocoGroupId();
    // Marketable buy limit for 5 at 10000: only 3 rest on the ask, so it fills partially.
    const sib = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'limit',
      px: 10050,
      qty: 1,
      oco: g,
    });
    const part = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 10000,
      qty: 5,
      oco: g,
    });
    expect(part.status).toBe('partial');
    expect(sib.status).toBe('cancelled');
    // Bracket: a target fill only shrinks the stop (unchanged behaviour).
    const entry = eng.place({
      accountId: 'A',
      instrumentId: 'Y',
      side: 'buy',
      type: 'market',
      qty: 2,
      bracket: { slTicks: 10, tpTicks: [5, 10] },
    });
    expect(entry.status).toBe('filled');
    const kids = eng.workingOrders('A', 'Y');
    expect(kids).toHaveLength(3);
    expect(eng.cancel(kids.find((k) => k.role === 'tp')!.id)).toBe(true);
    expect(eng.workingOrders('A', 'Y')).toHaveLength(2);
  });

  it('links and unlinks existing orders', () => {
    const { eng } = setup();
    const a = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 9990,
      qty: 1,
    });
    const b = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'limit',
      px: 10020,
      qty: 1,
    });
    expect(eng.linkOco([a.id])).toBeNull();
    const g = eng.linkOco([a.id, b.id]);
    expect(g).toBeTruthy();
    expect(a.oco).toBe(g);
    expect(eng.unlinkOco(a.id)).toBe(true);
    expect(a.oco).toBeUndefined();
    expect(b.oco).toBeUndefined(); // a group of one is dissolved
    eng.cancel(a.id);
    expect(b.status).toBe('working');
  });
});

describe('account state persistence', () => {
  it('round-trips positions, working orders, OCO groups, brackets and options', () => {
    const { eng } = setup();
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty: 2 });
    const entry = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 9980,
      qty: 1,
      bracket: { slTicks: 8, tpTicks: [4], breakeven: { trigger: 2, offset: 0 } },
    });
    const g = ocoGroupId();
    eng.place({
      accountId: 'A',
      instrumentId: 'Z',
      side: 'buy',
      type: 'limit',
      px: 9900,
      qty: 1,
      oco: g,
    });
    eng.place({
      accountId: 'A',
      instrumentId: 'Z',
      side: 'buy',
      type: 'stop',
      stopPx: 10100,
      qty: 1,
      oco: g,
    });
    eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'call',
      strike: 2500,
      expiry: '2030-01-18',
      side: 'buy',
      qty: 2,
      premium: 12,
      multiplier: 50,
      iv: 0.2,
      model: 'bs',
    });
    const balance = eng.accounts.get('A')!.balance;
    // JSON (what the profile store writes) and back.
    const saved = JSON.parse(JSON.stringify(eng.exportAccountState('A')));
    expect(saved.orders).toHaveLength(3);

    const { eng: fresh } = setup();
    fresh.accounts.get('A')!.balance = balance;
    expect(fresh.importAccountState('A', normalizeAccountState(saved))).toBe(true);
    expect(fresh.position('A', 'X')).toMatchObject({ qty: 2, avgPx: 10000 });
    expect(fresh.workingOrders('A')).toHaveLength(3);
    expect(fresh.optionPositions('A')[0]).toMatchObject({ qty: 2, avgPremium: 12, iv: 0.2 });

    // The restored entry still gets its bracket when it fills.
    fresh.onTrade('X', trade(9979));
    expect(fresh.orders.get(entry.id)!.status).toBe('filled');
    const kids = fresh.workingOrders('A', 'X');
    expect(kids.map((k) => k.role).sort()).toEqual(['sl', 'tp']);
    expect(fresh.bracketState(entry.id)).toEqual({ breakevenDone: false });

    // The restored OCO group still cancels its sibling.
    const z = fresh.workingOrders('A', 'Z');
    fresh.cancel(z[0]!.id);
    expect(fresh.workingOrders('A', 'Z')).toHaveLength(0);
  });

  it('drops damaged entries and dissolves OCO groups of one', () => {
    const s = normalizeAccountState({
      v: 1,
      positions: [{ instrumentId: 'X', qty: 1, avgPx: 10 }, { instrumentId: 'Y', qty: 0 }, null],
      orders: [
        {
          id: 'o1',
          accountId: 'A',
          instrumentId: 'X',
          side: 'buy',
          type: 'limit',
          px: 9,
          qty: 1,
          filled: 0,
          status: 'working',
          oco: 'g1',
        },
        { id: 'o2', accountId: 'A', instrumentId: 'X', side: 'buy', type: 'limit', qty: 1 },
        {
          id: 'o3',
          accountId: 'A',
          instrumentId: 'X',
          side: 'sell',
          type: 'stop',
          qty: 1,
          filled: 0,
          status: 'filled',
          stopPx: 5,
        },
      ],
      brackets: [{ entryId: 'nope', spec: {} }],
      managed: [{ entryId: 'e', instrumentId: 'X', dir: 2, avg: 1, steps: [] }],
      options: [
        { id: 'p', underlyingId: 'X', right: 'put', strike: 10, expiry: '2030-01-01', qty: -1 },
        { id: 'q', underlyingId: 'X', right: 'put', strike: 10, expiry: '2030-01-01', qty: 1 },
      ],
    });
    expect(s.positions).toHaveLength(1);
    expect(s.orders.map((o) => o.id)).toEqual(['o1']);
    expect(s.orders[0]!.oco).toBeUndefined();
    expect(s.brackets).toHaveLength(0);
    expect(s.managed).toHaveLength(0);
    expect(s.options).toHaveLength(0); // no avgPremium
    expect(normalizeAccountState('junk').orders).toEqual([]);
    expect(normalizeAccountState({ v: 2 }).positions).toEqual([]);
  });

  it('the risk engine continues the same trading day after a restore', () => {
    let now = Date.UTC(2026, 10, 13, 12);
    const { eng } = setup(() => now);
    const risk = new RiskEngine(eng, { now: () => now }, defaultRiskRules('UTC'));
    // Restart: the account resumes 1,500 below its start (losses made earlier today).
    risk.status('A'); // state created at the fresh 10,000 balance before the profile loads
    eng.accounts.get('A')!.balance = 8_500;
    risk.restoreDay('A', {
      day: '2026-11-13',
      dayStartEquity: 9_000,
      peakEquity: 10_000,
      tradesToday: 3,
    });
    let st = risk.status('A');
    expect(st.dayPnl).toBe(-500);
    expect(st.tradesToday).toBe(3);
    expect(st.drawdown).toBe(1_500);
    expect(st.locked).toBe(false);
    // A snapshot from another day starts the new day at the restored equity.
    risk.restoreDay('A', {
      day: '2026-11-12',
      dayStartEquity: 20_000,
      peakEquity: 0,
      tradesToday: 9,
    });
    st = risk.status('A');
    expect(st.dayPnl).toBe(0);
    expect(st.tradesToday).toBe(0);
    expect(risk.snapshotDay('A')).toMatchObject({ day: '2026-11-13', dayStartEquity: 8_500 });
    now += 1;
  });

  it('risk equity includes options marked to model', () => {
    const { eng } = setup();
    const risk = new RiskEngine(eng, {}, defaultRiskRules('UTC'));
    eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'call',
      strike: 100,
      expiry: '2030-01-18',
      side: 'buy',
      qty: 1,
      premium: 2,
      multiplier: 100,
    });
    eng.setOptionMarkModel(() => 5);
    expect(risk.status('A').equity).toBe(10_000 - 1 + 300);
  });
});

describe('options in the paper engine', () => {
  it('records premium debit / credit, closes at the mark and settles at expiry', () => {
    let now = Date.UTC(2026, 0, 1);
    const { eng } = setup(() => now);
    const exp = Date.UTC(2026, 0, 30, 8);
    const long = eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'call',
      strike: 100,
      expiry: '2026-01-30',
      expiryTs: exp,
      side: 'buy',
      qty: 2,
      premium: 3,
      multiplier: 100,
      name: 'X-30JAN26-100-C',
    });
    expect(typeof long).not.toBe('string');
    expect(eng.optionFills.at(-1)!.premiumFlow).toBe(-600); // debit
    eng.tradeOption({
      accountId: 'A',
      underlyingId: 'X',
      right: 'put',
      strike: 90,
      expiry: '2026-01-30',
      expiryTs: exp,
      side: 'sell',
      qty: 1,
      premium: 1.5,
      multiplier: 100,
    });
    expect(eng.optionFills.at(-1)!.premiumFlow).toBe(150); // credit
    eng.setOptionMarkModel((p) => (p.right === 'call' ? 4 : 1));
    expect(eng.optionUnrealized('A')).toBe(200 + 50);
    // Close half the calls at the model mark.
    const call = eng.optionPositions('A').find((p) => p.right === 'call')!;
    expect(typeof eng.closeOption(call.id)).not.toBe('string');
    expect(eng.optionPositions('A')).toHaveLength(1);
    expect(eng.optionFills.at(-1)).toMatchObject({ reason: 'close', realized: 200 });
    // Too late to trade, but settlement books intrinsic: put 90, spot 85 → short pays 5.
    now = exp + 1;
    expect(
      eng.tradeOption({
        accountId: 'A',
        underlyingId: 'X',
        right: 'put',
        strike: 90,
        expiry: '2026-01-30',
        expiryTs: exp,
        side: 'buy',
        qty: 1,
        premium: 1,
      }),
    ).toBe('Option has expired');
    expect(eng.settleExpiredOptions(() => undefined)).toBe(0); // waits for a price
    eng.setLocked('A', true);
    expect(eng.settleExpiredOptions(() => 85)).toBe(1);
    expect(eng.accounts.get('A')!.locked).toBe(true);
    expect(eng.optionPositions('A')).toHaveLength(0);
    const last = eng.optionFills.at(-1)!;
    expect(last).toMatchObject({ reason: 'expiry', premium: 5, realized: -350, commission: 0 });
    // Balance: start − commissions (2 + 1 + 2) + realized (200 − 350).
    expect(eng.accounts.get('A')!.balance).toBe(10_000 - 5 + 200 - 350);
  });
});
