import { describe, expect, it } from 'vitest';
import { getSettings, sectionKeys, validateSetting } from '../../state/settings';
import { floatingRect } from './apply';
import { readOpenWindowDetail } from '../workspaces/windowActions';

describe('layout settings', () => {
  it('declares the layout.* keys with defaults and validation', () => {
    const keys = sectionKeys('layout');
    expect(keys).toEqual(
      expect.arrayContaining([
        'layout.snapToGrid',
        'layout.gap',
        'layout.headerDensity',
        'layout.tabPosition',
        'layout.openChart',
        'layout.openDom',
        'layout.openTape',
        'layout.openModule',
        'layout.newWindowWidth',
        'layout.restoreMode',
        'layout.linkRed',
      ]),
    );
    const v = getSettings();
    expect(v['layout.gap']).toBe(4);
    expect(v['layout.openChart']).toBe('docked');
    expect(validateSetting('layout.gap', 99).ok).toBe(false);
    expect(validateSetting('layout.openDom', 'window').ok).toBe(false); // "coming"
    expect(validateSetting('layout.linkRed', '#abc')).toEqual({ ok: true, value: '#AABBCC' });
  });

  it('places new floating windows inside the docking area', () => {
    const area = { width: 1000, height: 600 };
    expect(floatingRect(area, { width: 400, height: 300 }, 'center', 0)).toEqual({
      x: 300,
      y: 150,
      width: 400,
      height: 300,
    });
    const c3 = floatingRect(area, { width: 400, height: 300 }, 'cascade', 3);
    expect(c3).toMatchObject({ x: 60 + 84, y: 40 + 84 });
    const big = floatingRect(
      { width: 500, height: 300 },
      { width: 900, height: 900 },
      'cascade',
      7,
    );
    expect(big.x + big.width).toBeLessThanOrEqual(500);
    expect(big.y + big.height).toBeLessThanOrEqual(300);
    expect(floatingRect(area, { width: 401, height: 299 }, 'top-left', 0, 8)).toEqual({
      x: 24,
      y: 24,
      width: 400,
      height: 296,
    });
  });

  it('reads both forms of the open-window event detail', () => {
    const s = { kind: 'module', module: 'news' };
    expect(readOpenWindowDetail(s)).toEqual({ state: s });
    expect(readOpenWindowDetail({ state: s, ref: 'a', dir: 'right' })).toMatchObject({ ref: 'a' });
    expect(readOpenWindowDetail({ foo: 1 })).toBeNull();
    expect(readOpenWindowDetail(null)).toBeNull();
  });
});
