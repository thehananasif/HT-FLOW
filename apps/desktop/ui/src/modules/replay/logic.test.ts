import { describe, expect, it } from 'vitest';
import type { Fill } from '@htflow/trading';
import {
  fillTags,
  normalizeBookmarks,
  normalizeDisplay,
  normalizeLoop,
  sameSavedState,
  savedStateOf,
  timelineEvents,
  DEFAULT_DISPLAY,
} from './logic';

const ev = (
  uid: string,
  t: number,
  impact: 'low' | 'medium' | 'high',
  currency = 'USD',
  allDay = false,
) => ({ uid, t, title: uid, currency, impact, allDay });

describe('replay display options', () => {
  it('fall back to defaults and clamp', () => {
    expect(normalizeDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
    const d = normalizeDisplay({ ghostBars: 9999, ghostOpacity: 0, tagSize: 2, eventImpact: 'x' });
    expect(d.ghostBars).toBe(300);
    expect(d.ghostOpacity).toBe(0.1);
    expect(d.tagSize).toBe(8);
    expect(d.eventImpact).toBe('medium');
    expect(normalizeDisplay({ fillTags: false }).fillTags).toBe(false);
  });
});

describe('timeline economic events', () => {
  const inst = { symbol: 'CLZ6', assetClass: 'futures' };
  const list = [
    ev('a', 1000, 'high'),
    ev('b', 2000, 'low'),
    ev('c', 3000, 'medium'),
    ev('d', 9000, 'high'),
    ev('e', 1500, 'high', 'USD', true),
  ];

  it('keeps events inside the range that pass the impact filter, sorted', () => {
    expect(timelineEvents(list, 0, 5000, inst, 'all').map((e) => e.uid)).toEqual(['a', 'b', 'c']);
    expect(timelineEvents(list, 0, 5000, inst, 'medium').map((e) => e.uid)).toEqual(['a', 'c']);
    expect(timelineEvents(list, 0, 5000, inst, 'high').map((e) => e.uid)).toEqual(['a']);
    expect(timelineEvents(list, 1500, 9500, inst, 'high').map((e) => e.uid)).toEqual(['d']);
  });

  it('drops events of currencies that do not move the instrument', () => {
    const l = [ev('usd', 1000, 'high', 'USD'), ev('nzd', 1100, 'high', 'NZD')];
    expect(timelineEvents(l, 0, 5000, inst, 'all').map((e) => e.uid)).toEqual(['usd']);
  });
});

describe('fill tags', () => {
  const f = (id: string, ts: number, side: 'buy' | 'sell', tag?: string, inst = 'replay:X'): Fill =>
    ({
      id,
      orderId: id,
      accountId: 'replay',
      instrumentId: inst,
      side,
      qty: 2,
      px: 100,
      ts,
      commission: 0,
      liquidity: 'taker',
      realized: 0,
      tag,
    }) as Fill;

  it('shows B / S tags of replay fills up to the replay clock only', () => {
    const fills = [
      f('1', 1000, 'buy', 'replay'),
      f('2', 2000, 'sell', 'replay'),
      f('3', 9000, 'buy', 'replay'),
      f('4', 1500, 'buy'),
      f('5', 1500, 'buy', 'replay', 'replay:Y'),
    ];
    const tags = fillTags(fills, 'replay:X', 5000);
    expect(tags.map((t) => t.text)).toEqual(['B 2', 'S 2']);
    expect(fillTags(fills, 'replay:X', 5000, false).map((t) => t.text)).toEqual(['B', 'S']);
    expect(fillTags(fills, 'replay:X', 500)).toEqual([]);
  });
});

describe('persisted bookmarks and loops', () => {
  it('validates, clamps and orders', () => {
    const b = normalizeBookmarks(
      [{ t: 300, label: 'c' }, { t: 100 }, { t: 5 }, { t: 9999 }, 'x', null],
      10,
      1000,
    );
    expect(b).toEqual([
      { t: 100, label: 'Bookmark' },
      { t: 300, label: 'c' },
    ]);
    expect(normalizeBookmarks('nope', 0, 1)).toEqual([]);
    expect(normalizeLoop({ from: -50, to: 400 }, 0, 1000)).toEqual({ from: 0, to: 400 });
    expect(normalizeLoop({ from: 500, to: 400 }, 0, 1000)).toBeNull();
    expect(normalizeLoop(null, 0, 1000)).toBeNull();
  });

  it('detects changes of the saved state', () => {
    const a = savedStateOf(
      [
        { t: 2, label: 'b' },
        { t: 1, label: 'a' },
      ],
      { from: 1, to: 2 },
    );
    expect(a.bookmarks.map((x) => x.t)).toEqual([1, 2]);
    expect(
      sameSavedState(
        a,
        savedStateOf(
          [
            { t: 1, label: 'a' },
            { t: 2, label: 'b' },
          ],
          { from: 1, to: 2 },
        ),
      ),
    ).toBe(true);
    expect(sameSavedState(a, savedStateOf([], null))).toBe(false);
  });
});
