import { describe, expect, it } from 'vitest';
import { OrderBook, type Aggressor, type Instrument, type Trade } from '@htflow/market-data';
import {
  CvdBarSeries,
  DomPressureTracker,
  PriceTracker,
  RollingFlow,
  SymbolAnalytics,
  buyPercent,
  conditionText,
  depthBands,
  imbalancePct,
  marketPressure,
  moneyChange,
  normalizeDivergenceOptions,
  normalizeThresholds,
  pressureSignal,
  priceChange,
  scanDivergences,
  type CvdBar,
} from './index';

let id = 1;
const tr = (ts: number, px: number, qty: number, side: Aggressor): Trade => ({
  ts,
  px,
  qty,
  side,
  id: id++,
});
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;

describe('Market Pressure', () => {
  it('buy % per rolling window and session', () => {
    const f = new RollingFlow();
    // 20 min ago: 100 sell; 10 min ago: 60 buy; 3 min ago: 30 buy / 10 sell; 30 s ago: 1 buy / 3 sell
    f.add(tr(T0 - 20 * MIN, 1, 100, 'sell'));
    f.add(tr(T0 - 10 * MIN, 1, 60, 'buy'));
    f.add(tr(T0 - 3 * MIN, 1, 30, 'buy'));
    f.add(tr(T0 - 3 * MIN, 1, 10, 'sell'));
    f.add(tr(T0 - 30_000, 1, 1, 'buy'));
    f.add(tr(T0 - 30_000, 1, 3, 'sell'));
    f.add(tr(T0 - 30_000, 1, 50, 'unknown'));
    const r = marketPressure(f, T0);
    expect(r.m1).toBe(25);
    expect(r.m5).toBeCloseTo((31 / 44) * 100, 10);
    expect(r.m15).toBeCloseTo((91 / 104) * 100, 10);
    expect(r.session).toBeCloseTo((91 / 204) * 100, 10);
    expect(r.vol).toEqual({ m1: 4, m5: 44, m15: 104, session: 204 });
  });

  it('session resets at the session boundary', () => {
    const f = new RollingFlow();
    f.add(tr(Date.UTC(2026, 10, 3, 23, 59), 1, 10, 'sell'));
    f.add(tr(Date.UTC(2026, 10, 4, 0, 1), 1, 5, 'buy'));
    expect(f.sessionTotals(Date.UTC(2026, 10, 4, 0, 2))).toEqual({ buy: 5, sell: 0 });
    expect(f.sessionTotals(Date.UTC(2026, 10, 5, 0, 2))).toEqual({ buy: 0, sell: 0 });
  });

  it('signals: strong buy ≥ 65 %, strong sell ≤ 35 %', () => {
    expect(buyPercent({ buy: 0, sell: 0 })).toBeNaN();
    expect(pressureSignal(65)).toBe('strong-buy');
    expect(pressureSignal(64.9)).toBe('neutral');
    expect(pressureSignal(35)).toBe('strong-sell');
    expect(pressureSignal(35.1)).toBe('neutral');
    expect(pressureSignal(Number.NaN)).toBe('neutral');
    expect(normalizeThresholds({ strongBuy: 70, strongSell: 20 })).toEqual({
      strongBuy: 70,
      strongSell: 20,
    });
    expect(normalizeThresholds({ strongBuy: 20, strongSell: 70 })).toEqual({
      strongBuy: 65,
      strongSell: 35,
    });
  });
});

describe('Price Change', () => {
  it('% / ticks over 5m, 1h, day; range position; VWAP distance', () => {
    const p = new PriceTracker();
    p.add(tr(Date.UTC(2026, 10, 4, 0, 0, 5), 1000, 1, 'buy')); // session open
    p.add(tr(T0 - 90 * MIN, 900, 1, 'sell')); // session low
    p.add(tr(T0 - 61 * MIN, 1100, 2, 'buy'));
    p.add(tr(T0 - 30 * MIN, 1200, 1, 'buy')); // session high
    p.add(tr(T0 - 6 * MIN, 1050, 1, 'sell'));
    p.add(tr(T0 - 1 * MIN, 1080, 5, 'buy'));
    const r = priceChange(p, T0);
    expect(r.last).toBe(1080);
    expect(r.ticks5m).toBe(30);
    expect(r.pct5m).toBeCloseTo((30 / 1050) * 100, 10);
    expect(r.ticks1h).toBe(-20);
    expect(r.pct1h).toBeCloseTo((-20 / 1100) * 100, 10);
    expect(r.ticksDay).toBe(80);
    expect(r.pctDay).toBe(8);
    expect(r.rangePos).toBeCloseTo(180 / 300, 10);
    const vwap = (1000 + 900 + 2200 + 1200 + 1050 + 5400) / 11;
    expect(r.vwap).toBeCloseTo(vwap, 10);
    expect(r.vsVwapTicks).toBeCloseTo(1080 - vwap, 10);
    expect(r.vsVwapPct).toBeCloseTo(((1080 - vwap) / vwap) * 100, 10);
    expect(p.sparkline(T0, 3, 5 * MIN)).toEqual([1200, 1050, 1080]);
  });

  it('NaN when history does not reach back; money value of a move', () => {
    const p = new PriceTracker();
    p.add(tr(T0 - 2 * MIN, 500, 1, 'buy'));
    const r = priceChange(p, T0);
    expect(r.ticks5m).toBeNaN();
    expect(r.rangePos).toBe(0.5);
    expect(moneyChange(4, { tickSize: 0.25, tickValue: 12.5 })).toBe(50);
    expect(moneyChange(40, { tickSize: 0.1, tickValue: 0 })).toBe(4);
  });
});

describe('DOM Pressure', () => {
  const book = () => {
    const b = new OrderBook();
    b.applySnapshot({
      ts: 0,
      bids: [
        [100, 10],
        [95, 20],
        [90, 30],
        [70, 40],
      ],
      asks: [
        [101, 5],
        [106, 5],
        [111, 10],
        [140, 99],
      ],
    });
    return b;
  };

  it('resting size within ±N ticks and imbalance %', () => {
    const bands = depthBands(book(), [5, 10, 25]);
    expect(bands).toEqual([
      { bid: 30, ask: 10 },
      { bid: 60, ask: 20 },
      { bid: 60, ask: 20 },
    ]);
    expect(imbalancePct(bands[0]!)).toBe(50);
    expect(imbalancePct({ bid: 0, ask: 0 })).toBe(0);
  });

  it('liquidity change per second and pull flag above 30 %', () => {
    const b = book();
    const t = new DomPressureTracker();
    t.sample(b, 1000);
    expect(t.reading(5)).toMatchObject({ bid: 30, ask: 10, changePerSec: 0, pullBid: false });
    b.applyDelta({ side: 'buy', px: 95, qty: 5 }); // bid within 5: 30 → 15 (−50 %)
    b.applyDelta({ side: 'sell', px: 101, qty: 4 }); // ask within 5: 10 → 9 (−10 %)
    t.sample(b, 3000);
    const r = t.reading(5)!;
    expect(r.bid).toBe(15);
    expect(r.ask).toBe(9);
    expect(r.changePerSec).toBe(-8);
    expect(r.pullBid).toBe(true);
    expect(r.pullAsk).toBe(false);
    expect(r.imbalance).toBe(25);
    expect(t.reading(7)).toBeNull();
  });
});

describe('Delta Divergence', () => {
  const bar = (i: number, h: number, l: number, ch: number, cl: number): CvdBar => ({
    t: i * MIN,
    o: l,
    h,
    l,
    c: h,
    cvdHigh: ch,
    cvdLow: cl,
    cvdClose: ch,
    vol: 1,
  });
  const o = { lookback: 3, absorption: false };

  it('price HH with CVD LH is bearish; price LL with CVD HL is bullish', () => {
    const bars = [
      bar(0, 100, 90, 50, 40),
      bar(1, 105, 95, 80, 60),
      bar(2, 103, 96, 70, 55),
      bar(3, 108, 99, 75, 65), // HH 108 > 105, CVD 75 < 80 → bearish
      bar(4, 102, 85, 60, 45), // LL 85 < 90?  lookback bars 1..3 low 95 → LL, CVD low 45 < 55 → no
      bar(5, 101, 80, 66, 50), // LL 80 < 85, CVD low 50 > 45 → bullish
    ];
    const s = scanDivergences(bars, MIN, o);
    expect(s.map((x) => [x.t / MIN, x.code, x.kind, x.px])).toEqual([
      [5, 'LL_HL', 'bullish', 80],
      [3, 'HH_LH', 'bearish', 108],
    ]);
    expect(conditionText(s[1]!, String)).toBe('Price HH 108 · CVD LH');
    expect(conditionText(s[0]!, String)).toBe('Price LL 80 · CVD HL');
  });

  it('no signal when CVD confirms; streaks report once; absorption is optional', () => {
    const confirm = [bar(0, 100, 90, 50, 40), bar(1, 101, 91, 51, 41), bar(2, 102, 92, 52, 42)];
    expect(scanDivergences([...confirm, bar(3, 110, 95, 60, 50)], MIN, o)).toEqual([]);
    const streak = [
      bar(0, 100, 90, 50, 40),
      bar(1, 101, 91, 80, 41),
      bar(2, 100, 92, 52, 42),
      bar(3, 110, 95, 60, 50),
      bar(4, 111, 96, 61, 51),
    ];
    expect(scanDivergences(streak, MIN, o)).toHaveLength(1);
    const absorb = [...confirm, bar(3, 101, 93, 90, 50)]; // CVD HH, price LH
    expect(scanDivergences(absorb, MIN, o)).toEqual([]);
    const a = scanDivergences(absorb, MIN, { lookback: 3, absorption: true });
    expect(a.map((x) => x.code)).toEqual(['CVD_HH']);
    expect(normalizeDivergenceOptions({ lookback: 1000, absorption: 'x' })).toEqual({
      lookback: 100,
      absorption: false,
    });
  });

  it('bar series tracks CVD extremes and closes quiet bars', () => {
    const s = new CvdBarSeries(MIN);
    expect(s.add(10, 100, 1, 1)).toBeNull();
    s.add(20, 103, 2, 3);
    s.add(30, 99, 5, -2);
    const closed = s.add(MIN + 5, 101, 1, -1)!;
    expect(closed).toMatchObject({ t: 0, o: 100, h: 103, l: 99, c: 99, cvdHigh: 3, cvdLow: -2 });
    expect(s.closeUntil(MIN + 10)).toBeNull();
    expect(s.closeUntil(2 * MIN)).toMatchObject({ t: MIN, cvdClose: -1 });
    expect(s.bars).toHaveLength(2);
  });
});

describe('SymbolAnalytics', () => {
  it('consumes a store incrementally', () => {
    const book = new OrderBook();
    book.applySnapshot({ ts: 0, bids: [[99, 4]], asks: [[100, 6]] });
    const store = {
      instrument: { id: 'x', tickSize: 1, tickValue: 1 } as Instrument,
      trades: [tr(T0 - 30_000, 100, 3, 'buy'), tr(T0 - 20_000, 99, 1, 'sell')],
      book,
      ready: true,
      lastTs: T0,
    };
    const a = new SymbolAnalytics(store, { budget: 1 });
    a.update();
    expect(a.caughtUp).toBe(false);
    a.update();
    expect(a.caughtUp).toBe(true);
    expect(a.cvd).toBe(2);
    expect(a.pressure().m1).toBe(75);
    store.trades.push(tr(T0 - 1000, 101, 4, 'sell'));
    a.update();
    expect(a.pressure().m1).toBe(37.5);
    expect(a.change().last).toBe(101);
    expect(a.domReading(5)).toMatchObject({ bid: 4, ask: 6, imbalance: -20 });
  });
});
