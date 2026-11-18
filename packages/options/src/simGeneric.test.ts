import { describe, expect, it } from 'vitest';
import { generateSimChain, genericSimUnderlying, niceStep } from './sim';

describe('generic simulated underlying', () => {
  it('niceStep rounds up to 1 / 2 / 2.5 / 5 x 10^k', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.1)).toBe(2);
    expect(niceStep(2.3)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0.03)).toBe(0.05);
    expect(niceStep(0)).toBe(1);
  });

  it('builds a labelled chain around the live price of any symbol', () => {
    const u = genericSimUnderlying('x:SOLUSDT', 'SOLUSDT', 172.4, 0.01);
    expect(u.strikeStep).toBeGreaterThan(0);
    const c = generateSimChain(
      u,
      { bid: 172.3, ask: 172.5, bidSize: 1, askSize: 1, last: 172.4 },
      Date.UTC(2026, 10, 16),
    );
    expect(c.simulated).toBe(true);
    expect(c.sourceLabel).toBe('Sim');
    expect(c.root).toBe('SOLUSDT');
    expect(c.expiries.length).toBeGreaterThan(5);
    const strikes = c.expiries[0]!.strikes.map((s) => s.strike);
    expect(Math.min(...strikes)).toBeLessThan(172.4);
    expect(Math.max(...strikes)).toBeGreaterThan(172.4);
  });
});
