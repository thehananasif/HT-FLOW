import { beforeEach, describe, expect, it } from 'vitest';
import { STATIC_DEFAULTS, useSettingsStore } from '../../state/settings';
import {
  baseSettings,
  effectiveSettings,
  nextOverrides,
  readParams,
  sanitizeOverrides,
} from './model';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('heatmap window settings', () => {
  it('defaults come from Settings → Heatmap', () => {
    const b = baseSettings({
      ...STATIC_DEFAULTS,
      'heatmap.palette': 'viridis',
      'heatmap.contrast': 70,
      'heatmap.normalization': 'session',
      'heatmap.bubbleScale': 200,
      'heatmap.historyMinutes': 30,
      'common.heatmapStartupLevels': 80,
    });
    expect(b.gradient).toBe('viridis');
    expect(b.contrast).toBe(70);
    expect(b.scope).toBe('session');
    expect(b.bubbleScale).toBe(50);
    expect(b.historyMinutes).toBe(30);
    expect(b.rangeLevels).toBe(80);
    // Spec defaults: Brightness 100, cut-offs 98 / 20, thermal (blue → white → yellow → red).
    const d = baseSettings();
    expect([d.brightness, d.cutoffUpper, d.cutoffLower, d.gradient]).toEqual([
      100,
      98,
      20,
      'thermal',
    ]);
  });
  it('validates and clamps overrides', () => {
    const b = baseSettings();
    const o = sanitizeOverrides(
      {
        brightness: 400,
        gamma: 0,
        scale: 'cubic',
        bubbleStyle: 'pie',
        buyColor: '',
        plainColor: 'red',
        gradient: 'nope',
        unknown: 1,
        customStops: [{ pos: 0, color: '#000000' }],
      },
      b,
    );
    expect(o).toEqual({ brightness: 100, gamma: 0.2, bubbleStyle: 'pie', buyColor: '' });
  });
  it('keeps the lower cut-off below the upper one', () => {
    const o = sanitizeOverrides({ cutoffLower: 90, cutoffUpper: 50 }, baseSettings());
    expect(o.cutoffLower).toBe(49);
  });
  it('stores only values that differ from the defaults', () => {
    const b = baseSettings();
    let o = nextOverrides({}, { bubbles: false, brightness: 80 }, b);
    expect(o).toEqual({ bubbles: false, brightness: 80 });
    o = nextOverrides(o, { bubbles: true }, b);
    expect(o).toEqual({ brightness: 80 });
    const custom = [
      { pos: 0, color: '#000000' },
      { pos: 1, color: '#FF0000' },
    ];
    o = nextOverrides(o, { gradient: 'custom', customStops: custom }, b);
    expect(effectiveSettings(readParams({ overrides: o })).customStops).toEqual(custom);
  });
  it('reads params with defaults and validation', () => {
    const p = readParams({ columnMs: 333, camera: { pitch: 9 }, mode3d: 'yes' });
    expect(p.columnMs).toBe(250);
    expect(p.camera.pitch).toBe(1.5);
    expect(p.mode3d).toBe(false);
    expect(readParams({ columnMs: 5000, mode3d: true }).columnMs).toBe(5000);
  });
});
