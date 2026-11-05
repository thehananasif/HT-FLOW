import { describe, expect, it } from 'vitest';
import { OrderBook } from '@htflow/market-data';
import { PaperEngine } from './paperEngine';
import {
  RISK_PRESETS,
  RiskEngine,
  dayKey,
  defaultRiskRules,
  inTradingHours,
  nextDayStart,
  sanitizeRiskRules,
  validateRiskRules,
  type RiskEvent,
  type RiskRules,
} from './risk';

// 2026-11-04 15:00:00 UTC (10:00 New York)
const T0 = Date.UTC(2026, 10, 4, 15, 0, 0);

function setup(rules: Partial<RiskRules> = {}) {
  const book = new OrderBook();
  const quote = (bid: number, ask: number) =>
    book.applySnapshot({
      ts: 0,
      bids: [
        [bid, 100],
        [bid - 1, 100],
      ],
      asks: [
        [ask, 100],
        [ask + 1, 100],
      ],
    });
  quote(9999, 10000);
  let now = T0;
  let mark: number | undefined;
  const eng = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.25, tickValue: 5 }),
    now: () => now,
  });
  eng.createAccount({ id: 'A', name: 'Paper', startingBalance: 50_000 });
  const risk = new RiskEngine(eng, { now: () => now, mark: () => mark });
  risk.setRules('A', { ...defaultRiskRules('UTC'), ...rules });
  const events: RiskEvent[] = [];
  risk.onEvent((e) => events.push(e));
  const buy = (qty: number) =>
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty });
  const sell = (qty: number) =>
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'sell', type: 'market', qty });
  return {
    eng,
    risk,
    events,
    quote,
    buy,
    sell,
    setNow: (t: number) => (now = t),
    setMark: (m: number | undefined) => (mark = m),
  };
}

describe('risk time helpers', () => {
  it('day keys, next local midnight and trading-hours windows respect the time zone', () => {
    expect(dayKey(T0, 'UTC')).toBe('2026-11-04');
    expect(dayKey(Date.UTC(2026, 10, 5, 3, 0), 'America/New_York')).toBe('2026-11-04');
    expect(nextDayStart(T0, 'UTC')).toBe(Date.UTC(2026, 10, 5));
    // New York midnight = 05:00 UTC in November (EST).
    expect(nextDayStart(T0, 'America/New_York')).toBe(Date.UTC(2026, 10, 5, 5));
    // DST end day (1 Nov 2026 is 25 h long in New York).
    expect(nextDayStart(Date.UTC(2026, 10, 1, 12), 'America/New_York')).toBe(
      Date.UTC(2026, 10, 2, 5),
    );
    expect(inTradingHours(T0, 'America/New_York', '09:30', '15:55')).toBe(true);
    expect(inTradingHours(T0, 'UTC', '09:30', '15:55')).toBe(true);
    expect(inTradingHours(T0, 'UTC', '16:00', '20:00')).toBe(false);
    // Overnight session 18:00 → 17:00.
    expect(inTradingHours(Date.UTC(2026, 10, 4, 17, 30), 'UTC', '18:00', '17:00')).toBe(false);
    expect(inTradingHours(Date.UTC(2026, 10, 4, 2, 0), 'UTC', '18:00', '17:00')).toBe(true);
  });

  it('presets and defaults validate; sanitize repairs partial data', () => {
    expect(validateRiskRules(defaultRiskRules('UTC'))).toEqual([]);
    for (const p of RISK_PRESETS) expect(validateRiskRules(p.rules('Europe/London'))).toEqual([]);
    const bad = { ...defaultRiskRules(), dailyLossLimit: { enabled: true, value: -5 } };
    expect(validateRiskRules(bad)).toContain('Daily loss limit must be greater than 0');
    expect(
      validateRiskRules({ ...defaultRiskRules(), tradingHours: { enabled: 1 } as never }),
    ).toContain('Trading hours must be HH:MM');
    const s = sanitizeRiskRules({ dailyLossLimit: { value: 250 }, timeZone: 'Nope/Zone' }, 'UTC');
    expect(s.dailyLossLimit).toEqual({ enabled: true, value: 250 });
    expect(s.timeZone).toBe('UTC');
    expect(s.maxPositionSize.perInstrument).toEqual({});
  });
});

describe('RiskEngine', () => {
  it('daily-loss breach from a fill auto-flattens and locks within 100 ms', () => {
    const t = setup({ dailyLossLimit: { enabled: true, value: 100 } });
    t.buy(3); // 3 @ 10000
    t.quote(9990, 9991);
    t.setMark(9990);
    const t0 = performance.now();
    // Partial close realizes 10 ticks × $5 × 1 = −$50; open 2 lots at the 9990 mark = −$100 → −$150.
    t.sell(1);
    const elapsed = performance.now() - t0;
    expect(t.eng.position('A', 'X').qty).toBe(0);
    expect(t.eng.accounts.get('A')!.locked).toBe(true);
    expect(elapsed).toBeLessThan(100);
    expect(t.events.find((e) => e.kind === 'lock')?.rule).toBe('dailyLossLimit');
    expect(t.risk.status('A').state).toBe('locked');
    expect(t.risk.status('A').lockedUntil).toBe(Date.UTC(2026, 10, 5));
    // Locked: new orders are rejected.
    expect(t.buy(1).status).toBe('rejected');
    // Next trading day the lock lifts automatically.
    t.setNow(Date.UTC(2026, 10, 5, 0, 0, 1));
    t.risk.tick();
    expect(t.eng.accounts.get('A')!.locked).toBe(false);
    expect(t.buy(1).status).toBe('filled');
  });

  it('mark-to-market breach without a fill is caught by tick()', () => {
    const t = setup({ dailyLossLimit: { enabled: true, value: 100 } });
    t.buy(2);
    t.setMark(9985); // 15 ticks × $5 × 2 = −$150 open
    expect(t.risk.status('A').dailyLossUsed).toBeCloseTo(1.5);
    t.risk.tick();
    expect(t.eng.position('A', 'X').qty).toBe(0);
    expect(t.eng.accounts.get('A')!.locked).toBe(true);
  });

  it('warns at 80% of the daily loss limit once', () => {
    const t = setup({ dailyLossLimit: { enabled: true, value: 100 } });
    t.buy(1);
    t.setMark(9984); // −$80
    t.risk.tick();
    t.risk.tick();
    expect(t.events.filter((e) => e.kind === 'warning')).toHaveLength(1);
    expect(t.eng.accounts.get('A')!.locked).toBe(false);
  });

  it('max position size rejects risk-increasing orders but allows reductions', () => {
    const t = setup({
      maxPositionSize: { enabled: true, value: 3, perInstrument: { Y: 1 } },
    });
    expect(t.buy(3).status).toBe('filled');
    const r = t.buy(1);
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatch(/Max position size 3/);
    expect(t.sell(2).status).toBe('filled');
    expect(
      t.eng.place({ accountId: 'A', instrumentId: 'Y', side: 'sell', type: 'market', qty: 2 })
        .status,
    ).toBe('rejected');
  });

  it('max orders per minute rejects the excess, then frees up after 60 s', () => {
    const t = setup({ maxOrdersPerMinute: { enabled: true, value: 3 } });
    const lim = (px: number) =>
      t.eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'limit', px, qty: 1 });
    expect(lim(9000).status).toBe('working');
    expect(lim(9001).status).toBe('working');
    expect(lim(9002).status).toBe('working');
    expect(lim(9003).reason).toMatch(/Max orders per minute/);
    t.setNow(T0 + 61_000);
    expect(lim(9004).status).toBe('working');
  });

  it('max trades per day warns at the limit and locks once flat', () => {
    const t = setup({ maxTradesPerDay: { enabled: true, value: 2 } });
    t.buy(1);
    t.sell(1);
    t.buy(1); // trade 2 opened → warning, still open
    expect(t.events.some((e) => e.kind === 'warning' && e.rule === 'maxTradesPerDay')).toBe(true);
    expect(t.eng.accounts.get('A')!.locked).toBe(false);
    t.sell(1); // flat → lock
    expect(t.eng.accounts.get('A')!.locked).toBe(true);
    expect(t.risk.status('A').tradesToday).toBe(2);
  });

  it('trading hours block new risk outside the window but allow closing', () => {
    const t = setup({ tradingHours: { enabled: true, start: '14:00', end: '16:00' } });
    expect(t.buy(1).status).toBe('filled');
    t.setNow(Date.UTC(2026, 10, 4, 16, 30));
    expect(t.buy(1).reason).toMatch(/Outside trading hours/);
    expect(t.sell(1).status).toBe('filled');
    expect(t.risk.status('A').outsideHours).toBe(true);
  });

  it('trailing drawdown locks until unlocked; profit target stops the day', () => {
    const t = setup({ trailingDrawdown: { enabled: true, value: 200 } });
    t.buy(2);
    t.setMark(10050); // +$500 open → new high-water mark
    t.risk.tick();
    t.setMark(10025); // −$250 from the peak
    t.risk.tick();
    expect(t.eng.accounts.get('A')!.locked).toBe(true);
    expect(t.risk.status('A').lockedUntil).toBeNull();
    t.setNow(Date.UTC(2026, 10, 6));
    t.risk.tick();
    expect(t.eng.accounts.get('A')!.locked).toBe(true); // not a day lock
    t.risk.unlock('A');
    expect(t.eng.accounts.get('A')!.locked).toBe(false);

    const p = setup({ profitTarget: { enabled: true, value: 100 } });
    p.buy(1);
    p.quote(10030, 10031);
    p.setMark(10030);
    p.sell(1); // +30 ticks × $5 = +$150
    expect(p.eng.accounts.get('A')!.locked).toBe(true);
    expect(p.events.find((e) => e.kind === 'lock')?.rule).toBe('profitTarget');
  });

  it('flattens before high-impact news and blocks new entries until the event', () => {
    const t = setup({ newsFlatten: { enabled: true, value: 2 } });
    t.buy(1);
    t.risk.setNewsEvents([{ ts: T0 + 90_000, title: 'FOMC' }]);
    t.risk.tick();
    expect(t.eng.position('A', 'X').qty).toBe(0);
    expect(t.buy(1).reason).toMatch(/news/);
    t.setNow(T0 + 91_000);
    expect(t.buy(1).status).toBe('filled');
  });

  it('override unlock suppresses the breached rule for the day; locks survive a snapshot', () => {
    const t = setup({ dailyLossLimit: { enabled: true, value: 100 } });
    t.buy(2);
    t.setMark(9985);
    t.risk.tick();
    const snap = t.risk.snapshotLocks();
    expect(snap.A?.rule).toBe('dailyLossLimit');
    t.risk.unlock('A');
    expect(t.buy(1).status).toBe('filled');
    t.risk.tick();
    expect(t.eng.accounts.get('A')!.locked).toBe(false);

    const u = setup();
    u.risk.restoreLocks(snap);
    expect(u.eng.accounts.get('A')!.locked).toBe(true);
    u.risk.restoreLocks({ A: { until: T0 - 1, rule: 'dailyLossLimit', reason: 'old' } });
  });

  it('dispose removes the hooks from the paper engine', () => {
    const t = setup({ maxPositionSize: { enabled: true, value: 1, perInstrument: {} } });
    t.risk.dispose();
    expect(t.eng.preTradeChecks).toHaveLength(0);
    expect(t.eng.postFillHooks).toHaveLength(0);
    expect(t.buy(5).status).toBe('filled');
  });
});
