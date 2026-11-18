import { getSettings, type SettingsValues } from '../../state/settings';

/* Settings → Performance (P27): FPS cap, renderer type and GPU preference. Pure helpers, tested. */

/**
 * Frames per second a chart may draw: the chart's own "update frequency" wins, otherwise the
 * global FPS cap (0 = display refresh rate). The smaller positive value wins when both are set
 * (the global cap is a ceiling).
 */
export function effectiveMaxFps(own: number, v: SettingsValues = getSettings()): number {
  const cap = Number(v['performance.fpsCap']);
  const c = Number.isFinite(cap) && cap > 0 ? cap : 0;
  if (own > 0 && c > 0) return Math.min(own, c);
  return own > 0 ? own : c;
}

/** Heatmap 3D renderer: the global renderer type forces WebGL2 / Canvas 2D; Auto keeps the heatmap's own choice. */
export function heatmapRenderer(
  own: 'webgl' | 'canvas',
  v: SettingsValues = getSettings(),
): 'webgl' | 'canvas' {
  const r = v['performance.renderer'];
  return r === 'webgl2' ? 'webgl' : r === 'canvas2d' ? 'canvas' : own;
}

/** WebGL context power preference: the heatmap adapter wins, then the global video adapter. */
export function gpuPreference(
  v: SettingsValues = getSettings(),
): 'default' | 'high-performance' | 'low-power' {
  const pick = (x: string) => (x === 'high-performance' || x === 'low-power' ? x : null);
  return pick(v['common.heatmapAdapter']) ?? pick(v['performance.videoAdapter']) ?? 'default';
}

/**
 * Chart geometry backend: Chart → Chart renderer wins; on Auto the global Performance → Renderer
 * type decides (Auto there too = WebGL2 on a hardware GPU, else Canvas 2D).
 */
export function chartRenderer(v: SettingsValues = getSettings()): 'auto' | 'webgl2' | 'canvas2d' {
  const ok = (x: unknown) => (x === 'webgl2' || x === 'canvas2d' ? x : null);
  return ok(v['chart.renderer']) ?? ok(v['performance.renderer']) ?? 'auto';
}

/** WebGL2 chart power preference: Settings → Performance → Video adapter. */
export function chartPowerPreference(
  v: SettingsValues = getSettings(),
): 'default' | 'high-performance' | 'low-power' {
  const x = v['performance.videoAdapter'];
  return x === 'high-performance' || x === 'low-power' ? x : 'default';
}

/** Minimum ms between frames for a draw loop capped at `fps` (0 = uncapped). */
export function frameInterval(fps: number): number {
  return fps > 0 ? 1000 / fps - 1 : 0;
}
