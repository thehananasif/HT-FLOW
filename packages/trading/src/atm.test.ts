import { describe, expect, it } from 'vitest';
import { OrderBook } from '@htflow/market-data';
import {
  ATM_PRESETS,
  atrTicks,
  blankAtm,
  describeAtm,
  normalizeAtm,
  resolveAtm,
  toTicks,
  validateAtm,
  type AtmTemplate,
} from './atm';
import { PaperEngine } from './paperEngine';

const futures = { tickSize: 0.25, tickValue: 12.5 }; // e.g. an index future
const crypto = { tickSize: 0.1, tickValue: 0 };

describe('ATM unit conversion', () => {
  it('converts ticks, points, $ per contract, % and ATR to whole ticks', () => {
    const ctx = { econ: futures, refPx: 20000, atrTicks: 6 };
    expect(toTicks(8, 'ticks', ctx)).toBe(8);
    expect(toTicks(2, 'points', ctx)).toBe(8);
    expect(toTicks(100, 'usd', ctx)).toBe(8);
    expect(toTicks(0.1, 'percent', ctx)).toBe(20);
    expect(toTicks(1.5, 'atr', ctx)).toBe(9);
    expect(toTicks(0.01, 'ticks', ctx)).toBe(1); // at least one tick
    expect(toTicks(1, 'atr', { econ: futures, refPx: 1 })).toBeNaN();
    expect(toTicks(-1, 'ticks', ctx)).toBeNaN();
  });

  it('$ on a linear instrument uses tick size × qty 1', () => {
    expect(toTicks(1, 'usd', { econ: crypto, refPx: 600000 })).toBe(10);
  });
});

describe('resolveAtm', () => {
  const ctx = { econ: futures, refPx: 20000, atrTicks: 4 };

  it('three targets with breakeven', () => {
    const t = ATM_PRESETS.find((p) => p.id === 'preset-3t')!;
    expect(resolveAtm(t, ctx)).toEqual({
      atm: 'Three targets + BE',
      slTicks: 12,
      tpTicks: [8, 16, 32],
      tpQty: [1, 1, 1],
      breakeven: { trigger: 8, offset: 1 },
    });
  });

  it('trailing SL in ATR units captures the ATR', () => {
    const t: AtmTemplate = {
      ...blankAtm('x'),
      sl: { enabled: true, type: 'trailing', value: 2, trailUnit: 'atr' },
      targets: [],
    };
    const b = resolveAtm(t, ctx);
    expect(b.slTrail).toEqual({ kind: 'atr', amount: 2, atrTicks: 4 });
    expect(b.slTicks).toBe(8);
    expect(b.tpTicks).toBeUndefined();
  });

  it('TP units: $ and % ', () => {
    const t: AtmTemplate = {
      ...blankAtm('x'),
      tpUnit: 'usd',
      targets: [
        { value: 50, qty: 2 },
        { value: 125, qty: 1 },
      ],
    };
    expect(resolveAtm(t, ctx).tpTicks).toEqual([4, 10]);
    expect(resolveAtm(t, ctx).tpQty).toEqual([2, 1]);
    expect(
      resolveAtm({ ...t, tpUnit: 'percent', targets: [{ value: 0.05, qty: 1 }] }, ctx).tpTicks,
    ).toEqual([10]);
  });

  it('throws a readable error when ATR is not available', () => {
    const t: AtmTemplate = {
      ...blankAtm('x'),
      sl: { enabled: true, type: 'atr', value: 1, trailUnit: 'ticks' },
    };
    expect(() => resolveAtm(t, { econ: futures, refPx: 1 })).toThrow(/ATR/);
  });

  it('disabled stop produces targets only; steps are copied', () => {
    const t: AtmTemplate = {
      ...blankAtm('x'),
      sl: { enabled: false, type: 'ticks', value: 10, trailUnit: 'ticks' },
      trailSteps: [{ trigger: 10, stopOffset: 4 }],
    };
    const b = resolveAtm(t, ctx);
    expect(b.slTicks).toBeUndefined();
    expect(b.trailSteps).toEqual([{ trigger: 10, stopOffset: 4 }]);
  });
});

describe('validation and persistence', () => {
  it('presets are valid', () => {
    for (const p of ATM_PRESETS) expect(validateAtm(p)).toEqual([]);
  });

  it('reports bad fields', () => {
    const t: AtmTemplate = {
      ...blankAtm('x', ' '),
      targets: [{ value: 0, qty: 0 }],
      breakeven: { enabled: true, trigger: 4, offset: 4 },
      trailSteps: [{ trigger: 5, stopOffset: 6 }],
    };
    const e = validateAtm(t);
    expect(e).toContain('Name is required');
    expect(e).toContain('Target 1: distance must be > 0');
    expect(e).toContain('Target 1: quantity share must be > 0');
    expect(e).toContain('Breakeven offset must be below its trigger');
    expect(e).toContain('Step 1: stop must be below its trigger');
  });

  it('normalizes persisted data and drops invalid templates', () => {
    expect(normalizeAtm({ id: 'a', name: 'A' })).toMatchObject({ id: 'a', tpUnit: 'ticks' });
    expect(normalizeAtm({ id: 'a', name: 'A', sl: { type: 'bogus', value: 4 } })!.sl.type).toBe(
      'ticks',
    );
    expect(normalizeAtm({ id: 'a', name: '' })).toBeNull();
    expect(normalizeAtm('nope')).toBeNull();
  });

  it('describes a template in one line', () => {
    expect(describeAtm(ATM_PRESETS.find((p) => p.id === 'preset-runner')!)).toBe(
      'SL 16T · TP 12/60T · BE +12→+2 · 3 steps',
    );
  });
});

describe('ATR', () => {
  it('averages the true range of the last N bars', () => {
    const bars = [
      { h: 10, l: 8, c: 9 },
      { h: 12, l: 9, c: 11 }, // TR 3
      { h: 11, l: 7, c: 8 }, // TR 4
      { h: 14, l: 10, c: 13 }, // TR max(4, 6, 2) = 6
    ];
    expect(atrTicks(bars, 3)).toBeCloseTo(13 / 3);
    expect(atrTicks(bars, 4)).toBeNaN();
  });
});

describe('ATM end to end in the paper engine', () => {
  it('a template bracket fills targets by weight and breakeven protects the rest', () => {
    const book = new OrderBook();
    book.applySnapshot({ ts: 0, bids: [[99, 50]], asks: [[100, 50]] });
    const eng = new PaperEngine({ book: () => book, economics: () => futures });
    eng.createAccount({ id: 'A', name: 'A' });
    const t: AtmTemplate = {
      ...blankAtm('t'),
      sl: { enabled: true, type: 'usd', value: 100, trailUnit: 'ticks' }, // 8 ticks
      tpUnit: 'points',
      targets: [
        { value: 1, qty: 1 }, // 4 ticks
        { value: 3, qty: 3 }, // 12 ticks
      ],
      breakeven: { enabled: true, trigger: 4, offset: 0 },
    };
    eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'market',
      qty: 4,
      bracket: resolveAtm(t, { econ: futures, refPx: 100 }),
    });
    const trade = (px: number) => ({ ts: 0, px, qty: 1, side: 'buy' as const, id: 0 });
    eng.onTrade('X', trade(105)); // through TP1 (104), triggers BE at +4
    const sl = eng.workingOrders('A', 'X').find((o) => o.role === 'sl')!;
    expect(sl.qty).toBe(3);
    expect(sl.stopPx).toBe(100);
    expect(eng.position('A', 'X').qty).toBe(3);
    eng.onTrade('X', trade(113));
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.position('A', 'X').realized).toBe((4 * 1 + 12 * 3) * 12.5);
    expect(eng.workingOrders('A', 'X')).toHaveLength(0);
  });
});
