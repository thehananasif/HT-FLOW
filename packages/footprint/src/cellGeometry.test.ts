import { describe, expect, it } from 'vitest';
import { RectBatch } from '@htflow/chart-engine';
import { buildFootprintCell, type CellParams } from './cellGeometry';
import { FOOTPRINT_MODES, footprintMode } from './modes';
import type { Row } from './merge';

const pal = {
  up: '#00ff00',
  down: '#ff0000',
  surface3: '#333333',
  clusterStrong: '#0000ff',
  divider: '#444444',
};
const row = { px: 100, vol: 10, bid: 4, ask: 6, delta: 2, trades: 3 } as Row;
const params = (mode: string): CellParams => ({
  mode: footprintMode(mode),
  palette: pal,
  opacity: 1,
  colorMode: 'volume',
  maxD: 4,
  maxSide: 8,
});

describe('footprint cell geometry', () => {
  it('plain cells are one rect graded by volume', () => {
    const b = buildFootprintCell(new RectBatch(), params('volume'), row, 0, 0, 40, 12, 1, 0.2);
    expect(b.count).toBe(1);
    expect(b.data[6]).toBe(1); // blue
    expect(b.data[7]).toBeCloseTo(0.73);
  });

  it('every mode produces rects inside the cell', () => {
    for (const m of FOOTPRINT_MODES.map((d) => d.id)) {
      const mode = footprintMode(m);
      const b = buildFootprintCell(new RectBatch(), params(m), row, 10, 20, 40, 12, 0.5, 0.2);
      expect(b.count, mode.id).toBeGreaterThan(0);
      for (let k = 0; k < b.count; k++) {
        const [x, y, w, h] = Array.from(b.data.slice(k * 8, k * 8 + 4));
        expect(x!).toBeGreaterThanOrEqual(10);
        expect(x! + w!).toBeLessThanOrEqual(50.0001);
        expect(y).toBe(20);
        expect(h).toBe(12);
      }
    }
  });
});
