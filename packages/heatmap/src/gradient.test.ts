import { describe, expect, it } from 'vitest';
import {
  applyTone,
  buildLut,
  GRADIENTS,
  heatIndex,
  lutFromStops,
  packColor,
  percentile,
  presetStops,
} from './gradient';

const rgbAt = (lut: Uint8ClampedArray, i: number) => [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];

describe('heat gradient', () => {
  it('builds a LUT that starts and ends at the stop colours', () => {
    const lut = buildLut(GRADIENTS.mono!);
    expect(rgbAt(lut, 0)).toEqual([10, 10, 10]);
    expect(rgbAt(lut, 255)).toEqual([255, 255, 255]);
  });
  it('applies cut-offs and scales', () => {
    expect(heatIndex(5, 10, 20, 'linear')).toBe(0);
    expect(heatIndex(15, 10, 20, 'linear')).toBe(128);
    expect(heatIndex(40, 10, 20, 'linear')).toBe(255);
    expect(heatIndex(15, 10, 20, 'sqrt')).toBeGreaterThan(128);
    expect(heatIndex(10.001, 10, 20, 'linear')).toBe(1);
  });
  it('takes percentiles', () => {
    expect(percentile(Float32Array.from([5, 1, 4, 2, 3]), 0.5)).toBe(3);
  });
});

describe('gradient LUT from editor stops', () => {
  it('interpolates between unsorted stops', () => {
    const lut = lutFromStops([
      { pos: 1, color: '#FFFFFF' },
      { pos: 0, color: '#000000' },
    ]);
    expect(rgbAt(lut, 0)).toEqual([0, 0, 0]);
    expect(rgbAt(lut, 255)).toEqual([255, 255, 255]);
    const mid = rgbAt(lut, 128)[0]!;
    expect(mid).toBeGreaterThan(120);
    expect(mid).toBeLessThan(136);
  });
  it('clamps outside the first / last stop', () => {
    const lut = lutFromStops([
      { pos: 0.25, color: '#FF0000' },
      { pos: 0.75, color: '#0000FF' },
    ]);
    expect(rgbAt(lut, 10)).toEqual([255, 0, 0]);
    expect(rgbAt(lut, 250)).toEqual([0, 0, 255]);
  });
  it('has 256 RGBA entries and keeps index 0 opaque', () => {
    const lut = lutFromStops(presetStops('thermal'), { opacity: 50 });
    expect(lut.length).toBe(1024);
    expect(lut[3]).toBe(255);
    expect(lut[255 * 4 + 3]).toBe(128);
  });
  it('bakes brightness in', () => {
    const lut = lutFromStops(presetStops('mono'), { brightness: 50 });
    expect(rgbAt(lut, 255)).toEqual([128, 128, 128]);
  });
  it('reads 8-digit hex alpha', () => {
    const lut = lutFromStops([
      { pos: 0, color: '#00000000' },
      { pos: 1, color: '#FFFFFF80' },
    ]);
    expect(lut[255 * 4 + 3]).toBe(128);
  });
  it('the spec default is blue → white → yellow → red', () => {
    const lut = lutFromStops(presetStops('thermal'));
    const lo = rgbAt(lut, 30);
    const white = rgbAt(lut, Math.round(0.6 * 255));
    const hi = rgbAt(lut, 255);
    expect(lo[2]!).toBeGreaterThan(lo[0]!);
    expect(white).toEqual([255, 255, 255]);
    expect(hi[0]!).toBeGreaterThan(hi[2]!);
  });
});

describe('tone curve', () => {
  it('is the identity at neutral contrast and gamma', () => {
    for (const t of [0, 0.1, 0.5, 0.9, 1]) expect(applyTone(t, 50, 1)).toBeCloseTo(t, 6);
  });
  it('gamma < 1 lifts small values, > 1 darkens them', () => {
    expect(applyTone(0.25, 50, 0.5)).toBeCloseTo(0.5, 6);
    expect(applyTone(0.5, 50, 2)).toBeCloseTo(0.25, 6);
  });
  it('contrast steepens around the middle and keeps the ends', () => {
    expect(applyTone(0.5, 100, 1)).toBeCloseTo(0.5, 6);
    expect(applyTone(0.3, 100, 1)).toBeLessThan(0.3);
    expect(applyTone(0.7, 100, 1)).toBeGreaterThan(0.7);
    expect(applyTone(0.3, 0, 1)).toBeGreaterThan(0.3);
    expect(applyTone(0, 100, 1)).toBe(0);
    expect(applyTone(1, 100, 1)).toBe(1);
  });
  it('packs colours in ImageData byte order', () => {
    const v = packColor('#102030');
    const bytes = new Uint8Array(new Uint32Array([v]).buffer);
    expect([...bytes]).toEqual([0x10, 0x20, 0x30, 255]);
  });
});
