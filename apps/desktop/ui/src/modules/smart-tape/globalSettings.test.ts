import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FILTER } from '@htflow/tape';
import { STATIC_DEFAULTS, setSetting, useSettingsStore } from '../../state/settings';
import {
  anchoredScroll,
  effectiveBigSize,
  effectiveFilter,
  effectiveSound,
  sideColor,
  tapeCapacity,
} from './globalSettings';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('Settings → Tape', () => {
  it('rows kept sets the buffer capacity', () => {
    expect(tapeCapacity()).toBe(5000);
    setSetting('tape.maxRows', 1200);
    expect(tapeCapacity()).toBe(1200);
  });
  it('minimum trade size raises the window filter', () => {
    expect(effectiveFilter(DEFAULT_FILTER)).toBe(DEFAULT_FILTER);
    setSetting('tape.minSize', 5);
    expect(effectiveFilter(DEFAULT_FILTER).minSize).toBe(5);
    expect(effectiveFilter({ ...DEFAULT_FILTER, minSize: 8 }).minSize).toBe(8);
  });
  it('global big-trade threshold applies when the window is automatic', () => {
    expect(effectiveBigSize(0)).toBe(0);
    setSetting('tape.bigTradeThreshold', 25);
    expect(effectiveBigSize(0)).toBe(25);
    expect(effectiveBigSize(10)).toBe(10);
  });
  it('beep on big trades turns sound on for every tape', () => {
    expect(effectiveSound(false)).toBe(false);
    setSetting('tape.beepOnBig', true);
    expect(effectiveSound(false)).toBe(true);
  });
  it('colour by side falls back to neutral', () => {
    const c = { up: 'u', down: 'd', neutral: 'n' };
    expect(sideColor(1, true, c)).toBe('u');
    expect(sideColor(-1, true, c)).toBe('d');
    expect(sideColor(1, false, c)).toBe('n');
  });
  it('follow new trades off anchors the scrolled view', () => {
    expect(anchoredScroll(6, 2, true)).toBe(6);
    expect(anchoredScroll(6, 2, false)).toBe(8);
    expect(anchoredScroll(0, 2, false)).toBe(0);
  });
});
