import { describe, expect, it } from 'vitest';
import { optionPrice, YEAR_MS } from './pricing';
import { isoExpiry, paperOptionExpiry, paperOptionLeg, paperOptionMark } from './paper';
import { pnlAt } from './strategy';

describe('paper options marks (P18)', () => {
  const now = Date.UTC(2026, 0, 1);
  const expiryTs = now + YEAR_MS / 4;
  const pos = {
    right: 'call' as const,
    strike: 100,
    expiry: isoExpiry(expiryTs),
    expiryTs,
    iv: 0.25,
    r: 0.05,
    model: 'bs' as const,
  };

  it('marks with Black-Scholes and the position IV', () => {
    const m = paperOptionMark(pos, 100, now)!;
    expect(m).toBeCloseTo(
      optionPrice({ kind: 'call', S: 100, K: 100, T: 0.25, r: 0.05, sigma: 0.25 }),
      10,
    );
    // Hull: S = K = 100, T = 0.25, r = 5 %, σ = 25 % → ≈ 5.60.
    expect(m).toBeCloseTo(5.598, 2);
  });

  it('values Black-76 legs off spot × basis and goes to intrinsic at expiry', () => {
    const b76 = { ...pos, model: 'b76' as const, basis: 1.02 };
    expect(paperOptionMark(b76, 100, now)).toBeCloseTo(
      optionPrice({ kind: 'call', S: 102, K: 100, T: 0.25, r: 0.05, sigma: 0.25, model: 'b76' }),
      10,
    );
    expect(paperOptionMark(pos, 112, expiryTs)).toBe(12);
    expect(paperOptionMark({ ...pos, right: 'put' }, 112, expiryTs + 1)).toBe(0);
    expect(paperOptionMark(pos, undefined, now)).toBeUndefined();
    expect(paperOptionMark(pos, 0, now)).toBeUndefined();
  });

  it('falls back to 08:00 UTC on the expiry date and builds analyser legs', () => {
    expect(paperOptionExpiry({ expiry: '2026-03-27' })).toBe(Date.UTC(2026, 2, 27, 8));
    const leg = paperOptionLeg({ ...pos, qty: -2, avgPremium: 6, basis: 1.01 }, 100, 101);
    expect(leg).toMatchObject({ kind: 'call', qty: -2, premium: 6, expiry: expiryTs, iv: 0.25 });
    expect(leg.basis).toBeCloseTo(1);
    const env = { model: 'bs' as const, r: 0.05, multiplier: 100, now };
    // Short call at 6 marked at the expiry with the axis at 104 (underlying 104): +2 × 100 × 2.
    expect(pnlAt([leg], 104, expiryTs, env)).toBeCloseTo(400);
  });
});
