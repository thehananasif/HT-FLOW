import { describe, expect, it } from 'vitest';
import { columnAt, moveKey, orderKeys, resizeWidth, sanitizeLayout } from './tableLogic';
import { computePopover } from './popoverLogic';

describe('table column layout', () => {
  it('orders keys, drops unknown and appends new columns', () => {
    expect(orderKeys(['a', 'b', 'c'], { order: ['c', 'x', 'a'], widths: {} })).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
  it('moves a column to the target position', () => {
    expect(moveKey(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveKey(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
  it('clamps resize and sanitises stored layouts', () => {
    expect(resizeWidth(100, -500)).toBe(40);
    expect(resizeWidth(100, 30.4)).toBe(130);
    expect(sanitizeLayout({ order: ['a', 'a', 3], widths: { a: 5, b: 'x', c: 99999 } })).toEqual({
      order: ['a'],
      widths: { a: 40, c: 1200 },
    });
    expect(sanitizeLayout('junk')).toEqual({ order: [], widths: {} });
  });
  it('finds the column under x', () => {
    const r = [
      { left: 0, right: 50 },
      { left: 50, right: 120 },
    ];
    expect(columnAt(r, 10)).toBe(0);
    expect(columnAt(r, 60)).toBe(1);
    expect(columnAt(r, 500)).toBe(1);
  });
});

describe('popover positioning', () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 200, height: 100 };
  it('opens below the anchor when it fits', () => {
    const p = computePopover({
      anchor: { left: 100, top: 100, width: 50, height: 20 },
      size,
      viewport,
    });
    expect(p).toEqual({ x: 100, y: 124, side: 'bottom' });
  });
  it('flips above when there is no room below', () => {
    const p = computePopover({
      anchor: { left: 100, top: 560, width: 50, height: 20 },
      size,
      viewport,
    });
    expect(p.side).toBe('top');
    expect(p.y).toBe(560 - 4 - 100);
  });
  it('shifts to stay inside the viewport', () => {
    const p = computePopover({
      anchor: { left: 760, top: 100, width: 30, height: 20 },
      size,
      viewport,
    });
    expect(p.x).toBe(800 - 200 - 8);
  });
  it('keeps the preferred side when the opposite is no better', () => {
    const p = computePopover({
      anchor: { left: 10, top: 10, width: 10, height: 10 },
      size: { width: 100, height: 900 },
      viewport,
    });
    expect(p.side).toBe('bottom');
  });
});
