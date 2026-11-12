import { describe, expect, it } from 'vitest';
import {
  fromScale,
  indexedOf,
  padRange,
  percentOf,
  priceMapping,
  scaleLabel,
  scaleLevels,
  toScale,
} from './priceScale';

describe('price scales', () => {
  it('linear mapping puts pmax at the top and pmin at the bottom', () => {
    const m = priceMapping(100, 200, 0, 100, 'linear', false);
    expect(m.yOf(200)).toBe(0);
    expect(m.yOf(100)).toBe(100);
    expect(m.yOf(150)).toBe(50);
    expect(m.pxAt(25)).toBe(175);
  });

  it('inverted mapping flips the axis', () => {
    const m = priceMapping(100, 200, 0, 100, 'linear', true);
    expect(m.yOf(100)).toBe(0);
    expect(m.yOf(200)).toBe(100);
    expect(m.pxAt(m.yOf(130))).toBeCloseTo(130, 9);
  });

  it('log mapping spaces equal ratios equally', () => {
    const m = priceMapping(100, 400, 0, 200, 'log', false);
    // 100 → 200 and 200 → 400 are both ×2, so each takes half the height.
    expect(m.yOf(400)).toBeCloseTo(0, 9);
    expect(m.yOf(200)).toBeCloseTo(100, 9);
    expect(m.yOf(100)).toBeCloseTo(200, 9);
    expect(m.pxAt(50)).toBeCloseTo(Math.sqrt(200 * 400), 6);
    for (const px of [101, 157, 333]) expect(m.pxAt(m.yOf(px))).toBeCloseTo(px, 6);
  });

  it('log mapping round-trips when inverted and offset', () => {
    const m = priceMapping(1000, 5000, 20, 300, 'log', true);
    for (const px of [1000, 1234, 4999]) expect(m.pxAt(m.yOf(px))).toBeCloseTo(px, 6);
    expect(m.yOf(1000)).toBeCloseTo(20, 9);
  });

  it('toScale / fromScale are inverse and clamp non-positive prices for log', () => {
    expect(fromScale(toScale(42, 'log'), 'log')).toBeCloseTo(42, 9);
    expect(toScale(42, 'percent')).toBe(42);
    expect(Number.isFinite(toScale(0, 'log'))).toBe(true);
    expect(Number.isFinite(toScale(-5, 'log'))).toBe(true);
  });

  it('percent and indexed values are relative to the base', () => {
    expect(percentOf(110, 100)).toBeCloseTo(10, 9);
    expect(percentOf(90, 100)).toBeCloseTo(-10, 9);
    expect(percentOf(90, 0)).toBe(0);
    expect(indexedOf(125, 100)).toBeCloseTo(125, 9);
    expect(indexedOf(50, 200)).toBeCloseTo(25, 9);
  });

  it('formats axis labels per mode', () => {
    const fmt = (px: number) => `$${px}`;
    expect(scaleLabel(105, 'linear', 100, fmt)).toBe('$105');
    expect(scaleLabel(105, 'log', 100, fmt)).toBe('$105');
    expect(scaleLabel(105, 'percent', 100, fmt)).toBe('+5.00%');
    expect(scaleLabel(95, 'percent', 100, fmt)).toBe('-5.00%');
    expect(scaleLabel(250, 'percent', 100, fmt)).toBe('+150.0%');
    expect(scaleLabel(105, 'indexed', 100, fmt)).toBe('105.00');
  });

  it('linear levels are evenly spaced nice steps inside the range', () => {
    const lv = scaleLevels(1003, 1097, 400, 'linear', 56);
    expect(lv.length).toBeGreaterThan(2);
    const step = lv[1]! - lv[0]!;
    for (let i = 1; i < lv.length; i++) expect(lv[i]! - lv[i - 1]!).toBe(step);
    expect(lv[0]).toBeGreaterThanOrEqual(1003);
    expect(lv[lv.length - 1]).toBeLessThanOrEqual(1097);
  });

  it('log levels are increasing and at least minPx apart on screen', () => {
    const h = 500;
    const lv = scaleLevels(100, 100_000, h, 'log', 40);
    expect(lv.length).toBeGreaterThan(3);
    const m = priceMapping(100, 100_000, 0, h, 'log', false);
    for (let i = 1; i < lv.length; i++) {
      expect(lv[i]!).toBeGreaterThan(lv[i - 1]!);
      expect(m.yOf(lv[i - 1]!) - m.yOf(lv[i]!)).toBeGreaterThanOrEqual(39.5);
    }
  });

  it('pads ranges in scale space', () => {
    expect(padRange(100, 200, 0.1, 'linear')).toEqual([90, 210]);
    const [a, b] = padRange(100, 400, 0.5, 'log');
    expect(a).toBeCloseTo(50, 6);
    expect(b).toBeCloseTo(800, 6);
  });
});
