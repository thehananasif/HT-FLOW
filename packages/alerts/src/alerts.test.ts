import { describe, expect, it } from 'vitest';
import {
  AlertEngine,
  alertStatus,
  describeCondition,
  newAlert,
  validateCondition,
  type AlertCondition,
  type AlertFire,
  type TradeLike,
} from './index';

function setup(condition: AlertCondition, patch = {}) {
  let now = 1_000_000;
  const eng = new AlertEngine(() => now);
  const fires: AlertFire[] = [];
  eng.onFire((f) => fires.push(f));
  eng.add(newAlert(condition, { cooldownMs: 0, ...patch }, now));
  return { eng, fires, tick: (ms: number) => (now += ms), get: () => eng.list()[0]! };
}
const t = (px: number, qty = 1, side = 'buy', ts = 0): TradeLike => ({ ts, px, qty, side });

describe('alert conditions — every type fires', () => {
  it('price cross (up / down / any) is edge-triggered', () => {
    const a = setup({ kind: 'price-cross', instrumentId: 'X', px: 100, direction: 'up' });
    a.eng.onTrades('X', [t(98), t(99)]);
    expect(a.fires).toHaveLength(0);
    a.eng.onTrades('X', [t(100)]);
    expect(a.fires).toHaveLength(1);
    a.eng.onTrades('X', [t(101), t(99)]); // crossing back down does not fire an "up" alert
    expect(a.fires).toHaveLength(1);
    a.eng.onTrades('Y', [t(90), t(110)]); // other instrument
    expect(a.fires).toHaveLength(1);
    const d = setup({ kind: 'price-cross', instrumentId: 'X', px: 100, direction: 'any' });
    d.eng.onTrades('X', [t(101), t(99), t(100)]);
    expect(d.fires.map((f) => f.px)).toEqual([99, 100]);
  });

  it('big trade ≥ size, with a side filter', () => {
    const a = setup({ kind: 'big-trade', instrumentId: 'X', minQty: 50, side: 'sell' });
    a.eng.onTrades('X', [t(10, 49, 'sell'), t(10, 80, 'buy')]);
    expect(a.fires).toHaveLength(0);
    a.eng.onTrades('X', [t(10, 50, 'sell')]);
    expect(a.fires).toHaveLength(1);
    expect(a.get().fired).toBe(1);
  });

  it('bar delta ≥ / ≤ fires once per bar and resets on the next bar', () => {
    const a = setup({ kind: 'bar-delta', instrumentId: 'X', barMs: 60_000, op: 'gte', value: 10 });
    a.eng.onTrades('X', [t(1, 6, 'buy', 1000), t(1, 2, 'sell', 2000)]);
    expect(a.fires).toHaveLength(0);
    a.eng.onTrades('X', [t(1, 6, 'buy', 3000), t(1, 9, 'buy', 4000)]);
    expect(a.fires).toHaveLength(1);
    a.eng.onTrades('X', [t(1, 3, 'buy', 61_000)]);
    expect(a.fires).toHaveLength(1);
    a.eng.onTrades('X', [t(1, 7, 'buy', 62_000)]);
    expect(a.fires).toHaveLength(2);
    const b = setup({ kind: 'bar-delta', instrumentId: 'X', barMs: 60_000, op: 'lte', value: -5 });
    b.eng.onTrades('X', [t(1, 5, 'sell', 0)]);
    expect(b.fires).toHaveLength(1);
  });

  it('DOM level size ≥ X within N ticks fires on appearance, re-arms when it goes away', () => {
    const a = setup({
      kind: 'dom-size',
      instrumentId: 'X',
      minQty: 500,
      withinTicks: 3,
      side: 'any',
    });
    const book = (bids: [number, number][], asks: [number, number][]) => ({
      bids: new Map(bids),
      asks: new Map(asks),
      bestBid: Math.max(...bids.map((b) => b[0])),
      bestAsk: Math.min(...asks.map((b) => b[0])),
    });
    a.eng.onBook(
      'X',
      book(
        [
          [99, 10],
          [90, 900],
        ],
        [[100, 10]],
      ),
    ); // big level too far away
    expect(a.fires).toHaveLength(0);
    a.eng.onBook(
      'X',
      book(
        [
          [99, 10],
          [96, 600],
        ],
        [[100, 10]],
      ),
    );
    expect(a.fires).toHaveLength(1);
    expect(a.fires[0]!.px).toBe(96);
    a.eng.onBook(
      'X',
      book(
        [
          [99, 10],
          [96, 700],
        ],
        [[100, 10]],
      ),
    ); // still there: no repeat
    expect(a.fires).toHaveLength(1);
    a.eng.onBook('X', book([[99, 10]], [[100, 10]]));
    a.eng.onBook(
      'X',
      book(
        [[99, 10]],
        [
          [100, 10],
          [102, 500],
        ],
      ),
    );
    expect(a.fires).toHaveLength(2);
  });

  it('connection lost (one instrument or any)', () => {
    const a = setup({ kind: 'connection-lost', instrumentId: null });
    a.eng.onStatus('X', 'live');
    a.eng.onStatus('X', 'disconnected');
    a.eng.onStatus('X', 'error'); // still down: no repeat
    a.eng.onStatus('Y', 'error');
    expect(a.fires).toHaveLength(2);
    const b = setup({ kind: 'connection-lost', instrumentId: 'X' });
    b.eng.onStatus('Y', 'error');
    expect(b.fires).toHaveLength(0);
  });
});

describe('alert lifecycle', () => {
  const big: AlertCondition = { kind: 'big-trade', instrumentId: 'X', minQty: 1, side: 'any' };

  it('cooldown, trigger count, expiry and enable', () => {
    const a = setup(big, { cooldownMs: 30_000, maxTriggers: 2 });
    a.eng.onTrades('X', [t(1), t(1)]);
    expect(a.fires).toHaveLength(1);
    expect(alertStatus(a.get(), 1_000_000)).toBe('cooldown');
    a.tick(30_000);
    a.eng.onTrades('X', [t(1)]);
    expect(a.fires).toHaveLength(2);
    a.tick(60_000);
    a.eng.onTrades('X', [t(1)]);
    expect(a.fires).toHaveLength(2);
    expect(alertStatus(a.get(), 2_000_000)).toBe('done');
    expect(a.eng.instruments()).toEqual([]);

    const e = setup(big, { expiresAt: 1_000_500 });
    expect(e.eng.instruments()).toEqual(['X']);
    e.tick(600);
    e.eng.onTrades('X', [t(1)]);
    expect(e.fires).toHaveLength(0);
    expect(alertStatus(e.get(), 1_000_600)).toBe('expired');

    const d = setup(big, { enabled: false });
    d.eng.onTrades('X', [t(1)]);
    expect(d.fires).toHaveLength(0);
    d.eng.update(d.get().id, { enabled: true });
    d.eng.onTrades('X', [t(1)]);
    expect(d.fires).toHaveLength(1);
    d.eng.remove(d.get().id);
    expect(d.eng.list()).toHaveLength(0);
  });

  it('validates and describes conditions', () => {
    expect(validateCondition(big)).toEqual([]);
    expect(validateCondition({ ...big, minQty: 0 })).toEqual(['Size must be greater than 0']);
    expect(
      validateCondition({ kind: 'price-cross', instrumentId: '', px: NaN, direction: 'any' }),
    ).toHaveLength(2);
    expect(
      describeCondition(
        { kind: 'price-cross', instrumentId: 'mock:NQ', px: 85000, direction: 'up' },
        { symbol: () => 'NQZ6', price: (_i, p) => (p / 4).toFixed(2) },
      ),
    ).toBe('NQZ6 price crosses above 21250.00');
    expect(describeCondition({ kind: 'connection-lost', instrumentId: null })).toBe(
      'Connection lost (any)',
    );
  });
});
