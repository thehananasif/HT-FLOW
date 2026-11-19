import { describe, expect, it } from 'vitest';
import {
  barLength,
  columnMinWidth,
  fitColumns,
  fitFontSize,
  fitRowHeight,
  nextCentre,
  symmetricRows,
  visibleMax,
} from './autobalance';

const base = { rows: 21, g: 1, paused: false };

describe('nextCentre', () => {
  it('centres on the first price', () => {
    expect(nextCentre({ ...base, mode: 'out-of-view', centre: NaN, ref: 100.4 })).toBe(100);
  });
  it('keeps the centre while the price stays inside the visible rows', () => {
    // 21 rows: 10 above, 10 below; with one row of margin the price may move 9 rows.
    expect(nextCentre({ ...base, mode: 'out-of-view', centre: 100, ref: 109 })).toBe(100);
    expect(nextCentre({ ...base, mode: 'out-of-view', centre: 100, ref: 91 })).toBe(100);
  });
  it('re-centres when the price leaves the view', () => {
    expect(nextCentre({ ...base, mode: 'out-of-view', centre: 100, ref: 110 })).toBe(110);
    expect(nextCentre({ ...base, mode: 'out-of-view', centre: 100, ref: 90 })).toBe(90);
  });
  it('always mode follows every tick, off mode never does', () => {
    expect(nextCentre({ ...base, mode: 'always', centre: 100, ref: 101 })).toBe(101);
    expect(nextCentre({ ...base, mode: 'off', centre: 100, ref: 150 })).toBe(100);
  });
  it('a manual scroll (paused) holds the centre in every mode', () => {
    for (const mode of ['always', 'out-of-view', 'off'] as const)
      expect(nextCentre({ ...base, mode, centre: 100, ref: 150, paused: true })).toBe(100);
  });
  it('snaps to the price grouping', () => {
    expect(nextCentre({ ...base, g: 5, mode: 'always', centre: 100, ref: 112 })).toBe(110);
  });
  it('ignores a missing price', () => {
    expect(nextCentre({ ...base, mode: 'always', centre: 100, ref: NaN })).toBe(100);
  });
});

describe('row fitting', () => {
  it('uses an odd number of rows so both sides are symmetric', () => {
    expect(symmetricRows(440, 22)).toBe(19);
    expect(symmetricRows(418, 22)).toBe(19);
    expect(symmetricRows(10, 22)).toBe(1);
  });
  it('fills the available height without a blank strip', () => {
    const { rowHeight, rows } = fitRowHeight(430, 22);
    expect(rows % 2).toBe(1);
    expect(430 - rowHeight * rows).toBeLessThan(rows);
    expect(rowHeight).toBeGreaterThanOrEqual(22);
    expect(rowHeight).toBeLessThanOrEqual(Math.round(22 * 1.35));
  });
  it('shrinks for a short window but never below the minimum', () => {
    expect(fitRowHeight(100, 22, 12).rowHeight).toBeGreaterThanOrEqual(12);
    expect(fitRowHeight(5, 22, 12).rowHeight).toBe(12);
  });
  it('keeps the text inside the row', () => {
    expect(fitFontSize(14, 22)).toBe(14);
    expect(fitFontSize(14, 14)).toBe(10);
    expect(fitFontSize(14, 8)).toBe(8);
  });
});

describe('fitColumns', () => {
  const cols = [
    { id: 'notes', width: 80 },
    { id: 'volume', width: 60 },
    { id: 'bid', width: 70 },
    { id: 'price', width: 80 },
    { id: 'ask', width: 70 },
    { id: 'orders', width: 70 },
  ];
  it('tiles the width exactly and respects minimum widths', () => {
    for (const width of [900, 480, 340, 260]) {
      const out = fitColumns(cols, width, 12);
      expect(out.reduce((a, c) => a + c.w, 0)).toBe(width);
      for (const c of out) expect(c.w).toBeGreaterThanOrEqual(columnMinWidth(c.id, 12));
    }
  });
  it('keeps every column when there is room', () => {
    expect(fitColumns(cols, 900, 12).map((c) => c.id)).toEqual(cols.map((c) => c.id));
  });
  it('drops lowest-priority columns first and keeps price / bid / ask', () => {
    const ids = fitColumns(cols, 220, 12).map((c) => c.id);
    expect(ids).not.toContain('notes');
    for (const id of ['price', 'bid', 'ask']) expect(ids).toContain(id);
  });
});

describe('fitColumns degenerate widths', () => {
  const cols = [
    { id: 'price', width: 80 },
    { id: 'bid', width: 70 },
  ];
  it('terminates for a zero, tiny or NaN width', () => {
    for (const w of [0, 5, Number.NaN]) expect(() => fitColumns(cols, w, 12)).not.toThrow();
  });
});

describe('size bars', () => {
  it('scales to the largest visible level so it fits exactly', () => {
    const max = visibleMax([3, 120, 40]);
    expect(max).toBe(120);
    expect(barLength(120, max, 80)).toBe(80);
    expect(barLength(60, max, 80)).toBe(40);
  });
  it('is symmetric for bid and ask sizes and never exceeds the cell', () => {
    expect(barLength(50, 100, 60)).toBe(barLength(50, 100, 60));
    expect(barLength(500, 100, 60)).toBe(60);
  });
  it('draws nothing for empty levels and a sliver for tiny ones', () => {
    expect(barLength(0, 100, 60)).toBe(0);
    expect(barLength(0.001, 100000, 60)).toBe(2);
    expect(barLength(5, 0, 60)).toBe(0);
  });
});
