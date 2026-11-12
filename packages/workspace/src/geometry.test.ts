import { describe, expect, it } from 'vitest';
import {
  clampRect,
  fitFloatingGroups,
  floatingScreenBounds,
  layoutTiles,
  monitorFor,
  restoreBounds,
  snapRect,
  specTiles,
  tabTiles,
} from './geometry';
import { LAYOUT_PRESETS, domState, type MonitorInfo } from './model';
import { STARTER_WORKSPACES } from './starters';

const M1: MonitorInfo = {
  name: 'DISPLAY1',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  primary: true,
  scale: 1,
};
const M2: MonitorInfo = {
  name: 'DISPLAY2',
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  primary: false,
  scale: 1,
};

describe('thumbnails', () => {
  it('splits tiles from specs and keeps them inside the unit square', () => {
    const grid = specTiles(LAYOUT_PRESETS.find((p) => p.id === 'grid')!.build('x'));
    expect(grid.map((t) => [t.x, t.y, t.w, t.h])).toEqual([
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ]);
    for (const s of STARTER_WORKSPACES)
      for (const t of tabTiles(s.build().tabs[0]!)) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(1.0000001);
        expect(t.y + t.h).toBeLessThanOrEqual(1.0000001);
      }
  });

  it('reads a dockview grid with sizes, nested orientation and floating groups', () => {
    const layout = {
      grid: {
        orientation: 'HORIZONTAL',
        width: 1000,
        height: 500,
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['a'], id: '1' }, size: 250 },
            {
              type: 'branch',
              size: 750,
              data: [
                { type: 'leaf', data: { views: ['b'], id: '2' }, size: 100 },
                { type: 'leaf', data: { views: ['c'], id: '3' }, size: 300 },
              ],
            },
          ],
        },
      },
      panels: {},
      floatingGroups: [
        {
          data: { views: ['d'], id: '4' },
          position: { left: 100, top: 50, width: 200, height: 100 },
        },
      ],
    };
    const t = layoutTiles(layout, { a: domState('x') });
    expect(t.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(t[0]).toMatchObject({ kind: 'dom', x: 0, w: 0.25, h: 1 });
    expect(t[1]).toMatchObject({ x: 0.25, y: 0, w: 0.75, h: 0.25 });
    expect(t[2]).toMatchObject({ y: 0.25, h: 0.75 });
    expect(t[3]).toMatchObject({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, floating: true });
  });
});

describe('snapping', () => {
  it('snaps rectangles to the grid', () => {
    expect(snapRect({ x: 13, y: 22, width: 3, height: 95 }, 8)).toEqual({
      x: 16,
      y: 24,
      width: 8,
      height: 96,
    });
    expect(snapRect({ x: 13, y: 22, width: 3, height: 95 }, 0)).toEqual({
      x: 13,
      y: 22,
      width: 3,
      height: 95,
    });
  });
});

describe('multi-monitor restore', () => {
  it('finds the monitor showing most of a window', () => {
    expect(monitorFor({ x: 1800, y: 0, width: 400, height: 300 }, [M1, M2])).toBe(M2);
    expect(monitorFor({ x: -5000, y: 0, width: 10, height: 10 }, [M1, M2])).toBeNull();
  });

  it('clamps a rectangle into an area', () => {
    expect(clampRect({ x: 1800, y: 900, width: 400, height: 300 }, M1)).toEqual({
      x: 1520,
      y: 780,
      width: 400,
      height: 300,
    });
    expect(clampRect({ x: 0, y: 0, width: 5000, height: 50 }, M1).width).toBe(1920);
  });

  it('keeps a window on its monitor when the monitor is still there', () => {
    const r = restoreBounds({ x: 2000, y: 100, width: 800, height: 600 }, M2, [M1, M2]);
    expect(r).toEqual({
      rect: { x: 2000, y: 100, width: 800, height: 600 },
      monitor: 'DISPLAY2',
      moved: false,
    });
  });

  it('moves a window from a missing monitor to the same relative place on the primary, fully visible', () => {
    const r = restoreBounds({ x: 3840, y: 1000, width: 1200, height: 600 }, M2, [M1]);
    expect(r.moved).toBe(true);
    expect(r.monitor).toBe('DISPLAY1');
    expect(r.rect.x + r.rect.width).toBeLessThanOrEqual(1920);
    expect(r.rect.y + r.rect.height).toBeLessThanOrEqual(1080);
    expect(r.rect.x).toBeGreaterThanOrEqual(0);
    expect(r.rect.width).toBe(1200);
  });

  it('fit mode scales to a monitor whose resolution changed', () => {
    const smaller: MonitorInfo = { ...M2, width: 1280, height: 720 };
    const r = restoreBounds({ x: 1920, y: 0, width: 2560, height: 1440 }, M2, [M1, smaller], 'fit');
    expect(r.rect).toEqual({ x: 1920, y: 0, width: 1280, height: 720 });
  });

  it('returns the rectangle unchanged when monitors are unknown', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(restoreBounds(rect, null, []).rect).toBe(rect);
  });
});

describe('floating windows', () => {
  const layout = {
    grid: { root: {}, width: 1000, height: 600, orientation: 'HORIZONTAL' },
    panels: {},
    floatingGroups: [
      { data: { views: ['a'] }, position: { left: 900, top: 500, width: 400, height: 300 } },
      { data: { views: ['b'] }, position: { right: 10, bottom: 10, width: 100, height: 100 } },
    ],
  };

  it('clamps floating windows into a smaller docking area', () => {
    const out = fitFloatingGroups(layout, { width: 800, height: 400 }) as typeof layout;
    expect(out.floatingGroups[0]!.position).toEqual({
      left: 400,
      top: 100,
      width: 400,
      height: 300,
    });
    expect(layout.floatingGroups[0]!.position.left).toBe(900); // input untouched
  });

  it('fit mode scales from the saved area and snaps to the grid', () => {
    const out = fitFloatingGroups(
      layout,
      { width: 500, height: 300 },
      { saved: { width: 1000, height: 600 }, mode: 'fit', grid: 10 },
    ) as typeof layout;
    expect(out.floatingGroups[1]!.position).toEqual({ left: 450, top: 250, width: 50, height: 50 });
  });

  it('computes screen bounds per floating window', () => {
    const b = floatingScreenBounds(layout, { width: 1000, height: 600 }, { x: 1920, y: 40 }, [
      M1,
      M2,
    ]);
    expect(b.a).toEqual({ x: 2820, y: 540, width: 400, height: 300, monitor: 'DISPLAY2' });
    expect(b.b!.x).toBe(1920 + 890);
  });
});
