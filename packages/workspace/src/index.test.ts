import { describe, expect, it } from 'vitest';
import { LAYOUT_PRESETS } from './index';

describe('layout presets', () => {
  it('defines the five presets with valid references', () => {
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual([
      'dom-chart-panel',
      'grid',
      'one-plus-two',
      'split',
      'single',
    ]);
    for (const p of LAYOUT_PRESETS) {
      const panels = p.build('mock:BTCUSDT');
      const ids = new Set<string>();
      for (const s of panels) {
        if (s.position) expect(ids.has(s.position.ref)).toBe(true);
        ids.add(s.id);
      }
    }
  });
  it('grid 2x2 contains the four core charts', () => {
    const grid = LAYOUT_PRESETS.find((p) => p.id === 'grid')!.build('x');
    expect(grid.map((s) => (s.state.kind === 'chart' ? s.state.template : s.state.kind))).toEqual([
      'candles-vp',
      'footprint',
      'liquidity-map',
      'order-flow-dark',
    ]);
  });
});
