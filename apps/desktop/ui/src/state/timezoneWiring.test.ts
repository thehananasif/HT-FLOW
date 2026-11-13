import { describe, expect, it } from 'vitest';
import { exchangeTimeTitle } from './format';
import { resolveCalendarZone } from '../modules/rss/shared';
import { recorderLimits } from '../modules/settings/effects';
import { STATIC_DEFAULTS } from './settings';

describe('Settings → Time zones', () => {
  it('exchange time tooltip follows the setting and the asset class', () => {
    const ts = Date.UTC(2026, 0, 15, 15, 30, 0);
    expect(exchangeTimeTitle(ts, 'crypto', false)).toBeUndefined();
    expect(exchangeTimeTitle(ts, 'crypto', true)).toContain('(UTC)');
    expect(exchangeTimeTitle(ts, 'future', true)).toContain('America/Chicago');
  });
  it('calendar zone follows the application zone unless set', () => {
    expect(resolveCalendarZone('app', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveCalendarZone('Asia/Tokyo', 'Europe/Berlin')).toBe('Asia/Tokyo');
  });
});

describe('Settings → Common recorder limits', () => {
  it('maps retention and disk budget', () => {
    expect(recorderLimits(STATIC_DEFAULTS)).toEqual({ retentionDays: 90, maxDiskGb: 50 });
    expect(
      recorderLimits({ 'common.tickRetentionDays': 7.4, 'common.recorderMaxGb': 120 }),
    ).toEqual({ retentionDays: 7, maxDiskGb: 120 });
  });
});
