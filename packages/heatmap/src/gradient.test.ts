import { describe, expect, it } from 'vitest';
import { buildLut, GRADIENTS, heatIndex, percentile } from './gradient';

describe('heat gradient', () => {
  it('builds a LUT that starts and ends at the stop colours', () => {
    const lut = buildLut(GRADIENTS.mono!);
    expect([lut[0], lut[1], lut[2]]).toEqual([10, 10, 10]);
    expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual([255, 255, 255]);
  });
  it('applies cut-offs and scales', () => {
    expect(heatIndex(5, 10, 20, 'linear')).toBe(0);
    expect(heatIndex(15, 10, 20, 'linear')).toBe(128);
    expect(heatIndex(40, 10, 20, 'linear')).toBe(255);
    expect(heatIndex(15, 10, 20, 'sqrt')).toBeGreaterThan(128);
  });
  it('takes percentiles', () => {
    expect(percentile(Float32Array.from([5, 1, 4, 2, 3]), 0.5)).toBe(3);
  });
});
