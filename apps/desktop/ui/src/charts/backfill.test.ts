import { describe, expect, it } from 'vitest';
import { DAY_MS, loadChunks, missingHistoryMs, openLoadChunks, progressLabel } from './history';

describe('native backfill (P06)', () => {
  const H = 3_600_000;
  it('loads enough bars for long timeframes in one extra request', () => {
    const now = 100 * DAY_MS;
    // 30 minutes loaded, 4 days wanted on a 1 m chart: four day chunks, nothing extra.
    const m1 = openLoadChunks(now - H / 2, now, 4, 60_000);
    expect(m1).toEqual(loadChunks(missingHistoryMs(now - H / 2, now, 4)));
    // A 4 h chart wants 120 bars = 20 days: the 4 day chunks plus one 16-day request.
    const h4 = openLoadChunks(now - H / 2, now, 4, 4 * H);
    expect(h4.length).toBe(5);
    expect(h4.reduce((a, b) => a + b, 0) + H / 2).toBe(20 * DAY_MS);
    // A 1 D chart: 120 days.
    const d1 = openLoadChunks(now - H / 2, now, 4, DAY_MS);
    expect(d1.reduce((a, b) => a + b, 0) + H / 2).toBe(120 * DAY_MS);
    // Empty store / non-time bars: plain load days.
    expect(openLoadChunks(undefined, now, 4, DAY_MS)).toEqual([]);
    expect(openLoadChunks(now - H, now, 1, undefined)).toEqual(loadChunks(DAY_MS - H));
  });

  it('labels download progress', () => {
    expect(
      progressLabel({ doneMs: 45, totalMs: 100, trades: 120000, phase: 'trades', throttled: true }),
    ).toBe('Downloading ticks 45 % · 120,000 ticks · rate limited, slowing down');
    expect(
      progressLabel({ doneMs: 200, totalMs: 100, trades: 8, phase: 'klines', throttled: false }),
    ).toBe('Loading bar history 100 % · 8 ticks');
    expect(
      progressLabel({ doneMs: 0, totalMs: 0, trades: 0, phase: 'done', throttled: false }),
    ).toBe('History loaded 0 % · 0 ticks');
  });
});
