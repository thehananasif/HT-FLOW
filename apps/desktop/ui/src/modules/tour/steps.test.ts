import { describe, expect, it } from 'vitest';
import { placeTooltip, spotlightBox, TOUR_STEPS } from './steps';

const size = { width: 300, height: 140 };

describe('placeTooltip', () => {
  it('centres when there is no target', () => {
    expect(placeTooltip(null, size, 1000, 600)).toEqual({ left: 350, top: 230, side: 'center' });
  });
  it('prefers below the target, clamped horizontally', () => {
    const p = placeTooltip({ left: 0, top: 10, width: 100, height: 30 }, size, 1000, 600);
    expect(p.side).toBe('below');
    expect(p.top).toBe(52);
    expect(p.left).toBe(8);
  });
  it('goes above when there is no room below (status bar)', () => {
    const p = placeTooltip({ left: 0, top: 570, width: 1000, height: 30 }, size, 1000, 600);
    expect(p.side).toBe('above');
    expect(p.top).toBe(570 - 12 - 140);
  });
  it('goes beside a tall target that fills the height', () => {
    const p = placeTooltip({ left: 20, top: 0, width: 200, height: 600 }, size, 1000, 600);
    expect(p.side).toBe('right');
    expect(p.left).toBe(232);
  });
  it('falls back to the centre when nothing fits', () => {
    expect(placeTooltip({ left: 0, top: 0, width: 400, height: 300 }, size, 400, 300).side).toBe(
      'center',
    );
  });
  it('keeps the card inside the viewport', () => {
    const p = placeTooltip({ left: 900, top: 100, width: 100, height: 50 }, size, 1000, 600);
    expect(p.left + size.width).toBeLessThanOrEqual(1000 - 8);
  });
});

describe('spotlightBox', () => {
  it('pads and clips to the viewport', () => {
    expect(spotlightBox({ left: 0, top: 0, width: 100, height: 50 }, 90, 500)).toEqual({
      left: 0,
      top: 0,
      width: 90,
      height: 54,
    });
  });
});

describe('TOUR_STEPS', () => {
  it('covers ribbon, chart, DOM, trading panel and status bar with unique ids', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['ribbon', 'chart', 'dom', 'trading', 'status']);
    for (const s of TOUR_STEPS) expect(s.targets.length).toBeGreaterThan(0);
  });
});
