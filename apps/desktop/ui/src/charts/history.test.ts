import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  autoLoadsHistory,
  loadChunks,
  missingHistoryMs,
  normalizeLoadDays,
  spanLabel,
} from './history';

describe('load days', () => {
  it('normalises the per-chart value', () => {
    expect(normalizeLoadDays(4)).toBe(4);
    expect(normalizeLoadDays('7')).toBe(7);
    expect(normalizeLoadDays(0)).toBe(1);
    expect(normalizeLoadDays(9999)).toBe(365);
    expect(normalizeLoadDays(2.6)).toBe(3);
    expect(normalizeLoadDays(undefined, 5)).toBe(5);
    expect(normalizeLoadDays('x')).toBe(4);
  });

  it('computes the missing history and day chunks', () => {
    const last = 10 * DAY_MS;
    expect(missingHistoryMs(last - 6 * 3_600_000, last, 4)).toBe(4 * DAY_MS - 6 * 3_600_000);
    expect(missingHistoryMs(last - 5 * DAY_MS, last, 4)).toBe(0);
    expect(missingHistoryMs(undefined, last, 4)).toBe(0);
    expect(loadChunks(2.5 * DAY_MS)).toEqual([DAY_MS, DAY_MS, DAY_MS / 2]);
    expect(loadChunks(0)).toEqual([]);
    expect(loadChunks(100 * DAY_MS, DAY_MS, 3)).toHaveLength(3);
  });

  it('auto-loads only from feeds with real older history', () => {
    expect(autoLoadsHistory('live', true)).toBe(true);
    expect(autoLoadsHistory('replay', true)).toBe(true);
    expect(autoLoadsHistory('mock', true)).toBe(false);
    expect(autoLoadsHistory('live', false)).toBe(false);
  });

  it('labels spans', () => {
    expect(spanLabel(6 * 3_600_000)).toBe('6 h');
    expect(spanLabel(1.5 * DAY_MS)).toBe('1.5 d');
    expect(spanLabel(30 * 60_000)).toBe('30 min');
  });
});
