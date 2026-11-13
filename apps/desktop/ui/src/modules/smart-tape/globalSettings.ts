import type { TapeFilter } from '@htflow/tape';
import { getSettings, type SettingsValues } from '../../state/settings';

/* Settings → Tape applied on top of each tape window's own parameters. Pure so they are unit-tested. */

/** Prints kept in a tape's ring buffer (Settings → Tape "Rows kept"; the buffer rounds up to a power of two). */
export function tapeCapacity(v: SettingsValues = getSettings()): number {
  const n = Number(v['tape.maxRows']);
  return Number.isFinite(n) ? Math.max(100, Math.min(100_000, Math.round(n))) : 5000;
}

/** The window's own minimum size filter, raised to the global minimum trade size. */
export function effectiveFilter(f: TapeFilter, v: SettingsValues = getSettings()): TapeFilter {
  const g = Number(v['tape.minSize']);
  return g > 0 && g > f.minSize ? { ...f, minSize: g } : f;
}

/** A window's own big-print size wins; 0 (automatic) falls back to the global threshold. */
export function effectiveBigSize(own: number, v: SettingsValues = getSettings()): number {
  return own > 0 ? own : Math.max(0, Number(v['tape.bigTradeThreshold']) || 0);
}

/** Sound on big prints: the window's toggle, or the global "Beep on big trades". */
export function effectiveSound(own: boolean, v: SettingsValues = getSettings()): boolean {
  return own || v['tape.beepOnBig'] === true;
}

/** Colour of a print's text / bars: aggressor side colours, or neutral when colouring is off. */
export function sideColor(
  side: number,
  colorBySide: boolean,
  c: { up: string; down: string; neutral: string },
): string {
  if (!colorBySide) return c.neutral;
  return side > 0 ? c.up : side < 0 ? c.down : c.neutral;
}

/**
 * Scroll offset that keeps the same prints in view while new ones arrive, when "Follow new
 * trades" is off (the offset grows by the number of rows added).
 */
export function anchoredScroll(scroll: number, added: number, follow: boolean): number {
  return follow ? scroll : scroll > 0 ? scroll + added : scroll;
}
