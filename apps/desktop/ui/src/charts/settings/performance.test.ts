import { describe, expect, it } from 'vitest';
import { STATIC_DEFAULTS } from '../../state/settings';
import { effectiveMaxFps, frameInterval, gpuPreference, heatmapRenderer } from './performance';

const v = (o: Record<string, unknown>) => ({ ...STATIC_DEFAULTS, ...o }) as typeof STATIC_DEFAULTS;

describe('Settings → Performance', () => {
  it('FPS cap is a ceiling over the chart update frequency', () => {
    expect(effectiveMaxFps(0, v({ 'performance.fpsCap': 0 }))).toBe(0);
    expect(effectiveMaxFps(0, v({ 'performance.fpsCap': 60 }))).toBe(60);
    expect(effectiveMaxFps(30, v({ 'performance.fpsCap': 60 }))).toBe(30);
    expect(effectiveMaxFps(144, v({ 'performance.fpsCap': 60 }))).toBe(60);
    expect(effectiveMaxFps(30, v({ 'performance.fpsCap': 0 }))).toBe(30);
  });
  it('frame interval', () => {
    expect(frameInterval(0)).toBe(0);
    expect(frameInterval(60)).toBeCloseTo(15.67, 1);
  });
  it('renderer type forces the heatmap 3D renderer', () => {
    expect(heatmapRenderer('webgl', v({ 'performance.renderer': 'auto' }))).toBe('webgl');
    expect(heatmapRenderer('webgl', v({ 'performance.renderer': 'canvas2d' }))).toBe('canvas');
    expect(heatmapRenderer('canvas', v({ 'performance.renderer': 'webgl2' }))).toBe('webgl');
  });
  it('video adapter feeds the GPU power preference', () => {
    expect(gpuPreference(v({}))).toBe('default');
    expect(gpuPreference(v({ 'performance.videoAdapter': 'low-power' }))).toBe('low-power');
    expect(
      gpuPreference(
        v({ 'performance.videoAdapter': 'low-power', 'common.heatmapAdapter': 'high-performance' }),
      ),
    ).toBe('high-performance');
  });
});
