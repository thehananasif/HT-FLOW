import { describe, expect, it } from 'vitest';
import { parseModify } from './inlineModify';

describe('inline order modify parsing', () => {
  const limit = { type: 'limit', px: 100, filled: 0 } as const;
  it('converts a typed price to ticks', () => {
    expect(parseModify(limit, 0.25, 'price', '5000.50')).toEqual({ px: 20002 });
  });
  it('edits the stop trigger for stop orders', () => {
    expect(parseModify({ type: 'stop', px: undefined, filled: 0 }, 0.25, 'price', '10')).toEqual({
      stopPx: 40,
    });
  });
  it('edits qty and refuses qty at or below what already filled', () => {
    expect(parseModify(limit, 0.25, 'qty', '3')).toEqual({ qty: 3 });
    expect(parseModify({ ...limit, filled: 2 }, 0.25, 'qty', '2')).toBeNull();
  });
  it('rejects junk', () => {
    expect(parseModify(limit, 0.25, 'price', 'abc')).toBeNull();
    expect(parseModify(limit, 0.25, 'price', '-1')).toBeNull();
    expect(parseModify(limit, 0, 'price', '5')).toBeNull();
  });
});
