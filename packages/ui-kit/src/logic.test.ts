import { describe, expect, it } from 'vitest';
import {
  hsvToRgb,
  normalizeColor,
  parseColor,
  pushRecent,
  rgbToHsv,
  toHex,
  toRgbString,
  withAlpha,
} from './colorMath';
import {
  addStop,
  gradientCss,
  gradientLut,
  removeStop,
  sampleGradient,
  updateStop,
  type GradientStop,
} from './gradient';
import {
  allBranchIds,
  checkState,
  flattenTree,
  navigate,
  toggleChecked,
  toggleExpanded,
  type TreeNode,
} from './treeLogic';
import { nextSort, scrollIntoViewTop, selectRow, sortRows, virtualRange } from './tableLogic';
import { clampRatio } from './splitLogic';
import { applyOrder, moveItem, sanitizeRibbon } from './ribbonLayout';

describe('colour conversion', () => {
  it('parses hex and rgb forms', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('20C77A')).toEqual({ r: 32, g: 199, b: 122, a: 1 });
    expect(parseColor('#00000080')?.a).toBeCloseTo(128 / 255, 5);
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  it('rejects garbage', () => {
    expect(parseColor('nope')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('rgb(1,2)')).toBeNull();
    expect(parseColor('rgb(a,b,c)')).toBeNull();
  });
  it('formats hex with optional alpha and clamps channels', () => {
    expect(toHex({ r: 32, g: 199, b: 122, a: 1 })).toBe('#20c77a');
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
    expect(toHex({ r: 300, g: -5, b: 0, a: 1 })).toBe('#ff0000');
    expect(toRgbString({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(toRgbString({ r: 1, g: 2, b: 3, a: 0.25 })).toBe('rgba(1, 2, 3, 0.25)');
  });
  it('round-trips through HSV', () => {
    for (const hex of ['#ff0000', '#20c77a', '#4fa3f7', '#b07cf0', '#808080', '#000000', '#ffffff']) {
      const c = parseColor(hex)!;
      expect(toHex(hsvToRgb(rgbToHsv(c)))).toBe(hex);
    }
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 1 }).h).toBe(120);
    expect(hsvToRgb({ h: 360, s: 1, v: 1, a: 1 })).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  it('normalizes and applies alpha', () => {
    expect(normalizeColor('rgb(255,0,0)')).toBe('#ff0000');
    expect(normalizeColor('zzz', '#111111')).toBe('#111111');
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff000080');
  });
  it('keeps recent colours unique, newest first and capped', () => {
    let r: string[] = [];
    r = pushRecent(r, '#FF0000');
    r = pushRecent(r, '#00ff00');
    r = pushRecent(r, '#ff0000');
    expect(r).toEqual(['#ff0000', '#00ff00']);
    expect(pushRecent(r, 'junk')).toEqual(r);
    let big: string[] = [];
    for (let i = 0; i < 20; i++) big = pushRecent(big, `#0000${i.toString(16).padStart(2, '0')}`, 5);
    expect(big).toHaveLength(5);
  });
});

describe('gradient maths', () => {
  const g: GradientStop[] = [
    { pos: 0, color: '#000000' },
    { pos: 1, color: '#ffffff' },
  ];
  it('interpolates linearly and clamps', () => {
    expect(sampleGradient(g, 0.5)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(sampleGradient(g, -1)).toMatchObject({ r: 0 });
    expect(sampleGradient(g, 2)).toMatchObject({ r: 255 });
  });
  it('handles unsorted multi-stop and alpha', () => {
    const s: GradientStop[] = [
      { pos: 1, color: '#0000ff00' },
      { pos: 0, color: '#ff0000ff' },
      { pos: 0.5, color: '#00ff00ff' },
    ];
    expect(sampleGradient(s, 0.25)).toMatchObject({ r: 128, g: 128, b: 0, a: 1 });
    expect(sampleGradient(s, 0.75).a).toBeCloseTo(0.5, 5);
  });
  it('adds a stop coloured from the existing ramp, removes down to two', () => {
    const added = addStop(g, 0.5);
    expect(added).toHaveLength(3);
    expect(added[1]).toEqual({ pos: 0.5, color: '#808080' });
    expect(removeStop(added, 1)).toHaveLength(2);
    expect(removeStop(g, 0)).toBe(g);
  });
  it('updates a stop with clamping', () => {
    expect(updateStop(g, 0, { pos: -3 })[0]!.pos).toBe(0);
    expect(updateStop(g, 1, { color: '#123456' })[1]!.color).toBe('#123456');
  });
  it('emits CSS and LUTs', () => {
    expect(gradientCss(g, 90)).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)');
    expect(gradientCss([])).toBe('transparent');
    const lut = gradientLut(g, 5);
    expect(lut).toHaveLength(5);
    expect(lut[0]!.r).toBe(0);
    expect(lut[4]!.r).toBe(255);
  });
});

describe('tree logic', () => {
  const tree: TreeNode[] = [
    {
      id: 'a',
      label: 'A',
      children: [
        { id: 'a1', label: 'A1' },
        { id: 'a2', label: 'A2', children: [{ id: 'a2x', label: 'A2X' }] },
      ],
    },
    { id: 'b', label: 'B' },
  ];
  it('flattens only expanded branches', () => {
    expect(flattenTree(tree, new Set()).map((r) => r.node.id)).toEqual(['a', 'b']);
    const rows = flattenTree(tree, new Set(['a', 'a2']));
    expect(rows.map((r) => r.node.id)).toEqual(['a', 'a1', 'a2', 'a2x', 'b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 2, 0]);
    expect(allBranchIds(tree)).toEqual(['a', 'a2']);
    expect(toggleExpanded(new Set(['a']), 'a').size).toBe(0);
  });
  it('navigates with the arrow keys', () => {
    let ex = new Set<string>();
    let rows = flattenTree(tree, ex);
    let r = navigate(rows, ex, 'a', 'ArrowRight');
    expect(r.expanded.has('a')).toBe(true);
    ex = r.expanded;
    rows = flattenTree(tree, ex);
    r = navigate(rows, ex, 'a', 'ArrowRight');
    expect(r.focusId).toBe('a1');
    r = navigate(rows, ex, 'a1', 'ArrowLeft');
    expect(r.focusId).toBe('a');
    r = navigate(rows, ex, 'a', 'ArrowLeft');
    expect(r.expanded.has('a')).toBe(false);
    expect(navigate(rows, ex, 'a', 'End').focusId).toBe('b');
    expect(navigate(rows, ex, 'b', 'Home').focusId).toBe('a');
    expect(navigate(rows, ex, 'b', 'ArrowDown').focusId).toBe('b');
    expect(navigate(rows, ex, 'a', 'ArrowUp').focusId).toBe('a');
  });
  it('propagates checkboxes with mixed state', () => {
    const a = tree[0]!;
    let c = toggleChecked(a.children![0]!, new Set());
    expect(checkState(a, c)).toBe('mixed');
    c = toggleChecked(a, c);
    expect(checkState(a, c)).toBe('checked');
    expect([...c].sort()).toEqual(['a1', 'a2x']);
    c = toggleChecked(a, c);
    expect(checkState(a, c)).toBe('unchecked');
  });
});

describe('table logic', () => {
  const rows = [
    { id: 'r1', n: 3, s: 'beta' },
    { id: 'r2', n: 1, s: 'alpha' },
    { id: 'r3', n: null as number | null, s: 'Gamma' },
    { id: 'r4', n: 1, s: 'delta' },
  ];
  const get = (r: (typeof rows)[number], k: string) => (r as Record<string, unknown>)[k];
  it('cycles sort state', () => {
    const a = nextSort(null, 'n');
    expect(a).toEqual({ key: 'n', dir: 'asc' });
    expect(nextSort(a, 'n')).toEqual({ key: 'n', dir: 'desc' });
    expect(nextSort({ key: 'n', dir: 'desc' }, 'n')).toBeNull();
    expect(nextSort(a, 's')).toEqual({ key: 's', dir: 'asc' });
  });
  it('sorts stably with nulls last in both directions', () => {
    expect(sortRows(rows, { key: 'n', dir: 'asc' }, get).map((r) => r.id)).toEqual(['r2', 'r4', 'r1', 'r3']);
    expect(sortRows(rows, { key: 'n', dir: 'desc' }, get).map((r) => r.id)).toEqual(['r1', 'r2', 'r4', 'r3']);
    expect(sortRows(rows, { key: 's', dir: 'asc' }, get).map((r) => r.id)).toEqual(['r2', 'r1', 'r4', 'r3']);
    expect(sortRows(rows, null, get)).toEqual(rows);
  });
  it('computes the virtual window', () => {
    expect(virtualRange(1000, 20, 0, 200, 2)).toEqual({ start: 0, end: 12, offsetTop: 0, totalHeight: 20000 });
    const v = virtualRange(1000, 20, 2000, 200, 2);
    expect(v.start).toBe(98);
    expect(v.end).toBe(112);
    expect(v.offsetTop).toBe(98 * 20);
    expect(virtualRange(5, 20, 0, 1000).end).toBe(5);
    expect(virtualRange(0, 20, 0, 100)).toMatchObject({ start: 0, end: 0 });
  });
  it('scrolls a row into view', () => {
    expect(scrollIntoViewTop(5, 20, 0, 200)).toBe(0);
    expect(scrollIntoViewTop(15, 20, 0, 200)).toBe(120);
    expect(scrollIntoViewTop(1, 20, 100, 200)).toBe(20);
  });
  it('selects single, toggle and range', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let s = selectRow(ids, { selected: new Set(), anchor: null }, 'b', {});
    expect([...s.selected]).toEqual(['b']);
    s = selectRow(ids, s, 'd', { shift: true });
    expect([...s.selected]).toEqual(['b', 'c', 'd']);
    s = selectRow(ids, s, 'a', { ctrl: true });
    expect(s.selected.has('a')).toBe(true);
    s = selectRow(ids, s, 'a', { ctrl: true });
    expect(s.selected.has('a')).toBe(false);
    s = selectRow(ids, s, 'e', { shift: true }, false);
    expect([...s.selected]).toEqual(['e']);
  });
});

describe('split + ribbon layout', () => {
  it('clamps ratio by min sizes', () => {
    expect(clampRatio(0.05, 1000, 100, 100)).toBeCloseTo(0.1);
    expect(clampRatio(0.99, 1000, 100, 100)).toBeCloseTo(0.9);
    expect(clampRatio(0.4, 1000, 100, 100)).toBe(0.4);
    expect(clampRatio(NaN, 1000, 100, 100)).toBe(0.5);
    expect(clampRatio(0.2, 0, 100, 100)).toBe(0.5);
  });
  it('sanitizes, orders and moves', () => {
    const known = ['a', 'b', 'c'];
    expect(sanitizeRibbon({ hidden: ['a', 'zzz', 'a', 3], order: ['c'] }, known)).toEqual({ hidden: ['a'], order: ['c'] });
    expect(sanitizeRibbon(null, known)).toEqual({ hidden: [], order: [] });
    expect(applyOrder(known, ['c', 'x', 'a'])).toEqual(['c', 'a', 'b']);
    expect(moveItem(known, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(known, 0, 9)).toEqual(known);
  });
});
