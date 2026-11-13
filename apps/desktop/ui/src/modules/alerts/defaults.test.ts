import { describe, expect, it } from 'vitest';
import { alertDefaults, canAddAlert } from './defaults';

describe('Settings → Alerts defaults', () => {
  it('repeat, cooldown and expiry of new alerts', () => {
    expect(alertDefaults({ repeat: 'once', cooldownSec: 10, expiryDays: 0 }, 1000)).toEqual({
      maxTriggers: 1,
      cooldownMs: 10_000,
      expiresAt: null,
    });
    expect(alertDefaults({ repeat: 'every', cooldownSec: 5, expiryDays: 2 }, 1000)).toEqual({
      maxTriggers: 0,
      cooldownMs: 5000,
      expiresAt: 1000 + 2 * 86_400_000,
    });
    expect(alertDefaults({ repeat: 'bar', cooldownSec: 5, expiryDays: 0 }, 0).cooldownMs).toBe(
      60_000,
    );
  });

  it('max active alerts', () => {
    expect(canAddAlert(199, 200)).toBe(true);
    expect(canAddAlert(200, 200)).toBe(false);
  });
});
