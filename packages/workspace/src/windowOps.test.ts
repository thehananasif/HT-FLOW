import { describe, expect, it } from 'vitest';
import { chartState, domState, LINK_COLORS, type WindowState } from './model';
import {
  cloneWindowState,
  freeLinkColor,
  linkedWindowState,
  linkGroups,
  openModeType,
  setWindowLink,
} from './windowOps';

describe('window operations', () => {
  it('clone keeps every setting and is independent', () => {
    const src = chartState('mock:ESZ6', 'footprint', {
      link: 'red',
      ext: { drawings: { items: [1] } },
    });
    const c = cloneWindowState(src);
    expect(c).toEqual(src);
    (c as typeof src).ext!.drawings = null;
    expect(src.ext!.drawings).toEqual({ items: [1] });
  });

  it('linked window shares instrument and group; an unlinked source gets a free colour', () => {
    const windows: Record<string, WindowState> = {
      a: chartState('mock:NQZ6', 'footprint', { link: 'red' }),
      b: chartState('mock:ESZ6', 'candles-vp'),
    };
    const r1 = linkedWindowState(windows.a!, 'dom', windows, 'x');
    expect(r1.state).toMatchObject({ kind: 'dom', instrumentId: 'mock:NQZ6', link: 'red' });
    expect(r1.sourceLink).toBeNull();

    const r2 = linkedWindowState(windows.b!, 'heatmap', windows, 'x');
    expect(r2.sourceLink).toBe('green');
    expect(r2.state).toMatchObject({ kind: 'chart', template: 'liquidity-map', link: 'green' });

    const t = linkedWindowState(windows.a!, 'tape', windows, 'x');
    expect(t.state).toEqual({
      kind: 'module',
      module: 'smart-tape',
      params: { instrumentId: 'mock:NQZ6', link: 'red' },
    });
    const o = linkedWindowState(t.state, 'options', windows, 'x');
    expect(o.state).toMatchObject({
      module: 'options-board',
      params: { instrumentId: 'mock:NQZ6', link: 'red' },
    });

    const ch = linkedWindowState(
      { ...windows.a!, timeframe: { kind: 'tick', n: 500 } } as WindowState,
      'chart',
      windows,
      'x',
    );
    expect(ch.state).toMatchObject({ template: 'footprint', timeframe: { kind: 'tick', n: 500 } });
  });

  it('link groups list members and instruments', () => {
    const windows: Record<string, WindowState> = {
      a: chartState('mock:NQZ6', 'footprint', { link: 'red' }),
      b: domState('mock:NQZ6', { link: 'red' }),
      c: setWindowLink(
        { kind: 'module', module: 'smart-tape', params: { instrumentId: 'mock:ESZ6' } },
        'blue',
      ),
      d: { kind: 'module', module: 'news' },
    };
    const g = Object.fromEntries(linkGroups(windows).map((x) => [x.color, x]));
    expect(g.red).toMatchObject({ windowIds: ['a', 'b'], instruments: ['mock:NQZ6'] });
    expect(g.blue).toMatchObject({ windowIds: ['c'], instruments: ['mock:ESZ6'] });
    expect(g.none!.windowIds).toEqual(['d']);
    expect(freeLinkColor(windows)).toBe('green');
  });

  it('open-mode types and CSS colours', () => {
    expect(openModeType(chartState('x', 'footprint'))).toBe('chart');
    expect(openModeType(domState('x'))).toBe('dom');
    expect(openModeType({ kind: 'module', module: 'bidask-tape' })).toBe('tape');
    expect(openModeType({ kind: 'module', module: 'news' })).toBe('module');
    expect(LINK_COLORS.red).toBe('var(--ht-link-red, #F04A5D)');
  });
});
