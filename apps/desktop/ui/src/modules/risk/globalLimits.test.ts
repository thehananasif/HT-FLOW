import { describe, expect, it } from 'vitest';
import { checkGlobalLimits, increasesRisk, lockEnd, type GlobalRiskLimits } from './globalLimits';

const OFF: GlobalRiskLimits = {
  maxDailyLoss: 0,
  maxPositionSize: 0,
  maxOrderSize: 0,
  maxTradesPerDay: 0,
  priceCollarTicks: 0,
  warnAtPct: 80,
  onBreach: 'block',
  lockUntil: 'tomorrow',
};
const ctx = { position: 0, lastPx: 1000, dayPnl: 0, tradesToday: 0 };
const buy = (qty: number, extra = {}) => ({ side: 'buy' as const, qty, type: 'market' as const, ...extra });

describe('Settings → Risk global limits', () => {
  it('all limits off → every order passes', () => {
    expect(checkGlobalLimits(buy(1000), ctx, OFF).verdict).toBe('ok');
  });

  it('max order size rejects, and warns near the limit', () => {
    const lim = { ...OFF, maxOrderSize: 10 };
    expect(checkGlobalLimits(buy(11), ctx, lim)).toMatchObject({ verdict: 'reject' });
    expect(checkGlobalLimits(buy(9), ctx, lim)).toMatchObject({ verdict: 'warn' });
    expect(checkGlobalLimits(buy(2), ctx, lim).verdict).toBe('ok');
    // "Warn only" turns the rejection into a warning.
    expect(checkGlobalLimits(buy(11), ctx, { ...lim, onBreach: 'warn' }).verdict).toBe('warn');
  });

  it('max position size only limits orders that add to the position', () => {
    const lim = { ...OFF, maxPositionSize: 5 };
    expect(checkGlobalLimits(buy(2), { ...ctx, position: 4 }, lim).verdict).toBe('reject');
    expect(
      checkGlobalLimits({ ...buy(8), side: 'sell' }, { ...ctx, position: 4 }, lim).verdict,
    ).toBe('ok'); // 4 → −4
  });

  it('price collar rejects far limit orders', () => {
    const lim = { ...OFF, priceCollarTicks: 20 };
    expect(checkGlobalLimits(buy(1, { type: 'limit', px: 1030 }), ctx, lim).verdict).toBe('reject');
    expect(checkGlobalLimits(buy(1, { type: 'limit', px: 1010 }), ctx, lim).verdict).toBe('ok');
  });

  it('daily trades and daily loss block new risk but not exits', () => {
    const lim = { ...OFF, maxTradesPerDay: 3, maxDailyLoss: 500 };
    expect(checkGlobalLimits(buy(1), { ...ctx, tradesToday: 3 }, lim).verdict).toBe('reject');
    const loss = checkGlobalLimits(buy(1), { ...ctx, dayPnl: -600 }, lim);
    expect(loss).toMatchObject({ verdict: 'reject', lossBreach: true });
    expect(
      checkGlobalLimits({ ...buy(1), side: 'sell' }, { ...ctx, position: 2, dayPnl: -600 }, lim)
        .verdict,
    ).toBe('ok');
  });

  it('lock duration and risk direction', () => {
    expect(lockEnd('hour', 0, 99)).toBe(3_600_000);
    expect(lockEnd('tomorrow', 0, 99)).toBe(99);
    expect(lockEnd('manual', 0, 99)).toBe(Infinity);
    expect(increasesRisk(0, 'sell')).toBe(true);
    expect(increasesRisk(3, 'sell')).toBe(false);
  });
});
