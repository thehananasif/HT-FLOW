import { describe, expect, it } from 'vitest';
import { fitText } from './candles';

/** 6 px per character, whatever the font. */
const ctx = { measureText: (t: string) => ({ width: t.length * 6 }) as TextMetrics };

describe('fitText (legend / label ellipsis)', () => {
  it('leaves text that fits untouched', () => {
    expect(fitText(ctx, 'CLZ6 · M5', 100)).toBe('CLZ6 · M5');
  });
  it('shortens long text with an ellipsis so it never exceeds the width', () => {
    const t = 'Continuous(CL) · Replay @ Replay · M5 · Bid x Ask';
    const out = fitText(ctx, t, 120);
    expect(out.endsWith('…')).toBe(true);
    expect(ctx.measureText(out).width).toBeLessThanOrEqual(120);
    expect(out.length).toBeGreaterThan(10);
  });
  it('returns nothing when there is no room at all', () => {
    expect(fitText(ctx, 'abc', 0)).toBe('');
    expect(fitText(ctx, 'abcdef', 5)).toBe('');
  });
});
