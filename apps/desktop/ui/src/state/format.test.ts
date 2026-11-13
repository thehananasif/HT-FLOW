import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  HIDDEN_MONEY,
  maskAccount,
  type TimeFormatOptions,
} from './format';

// 2026-03-31 14:05:09.042 UTC
const TS = Date.UTC(2026, 2, 31, 14, 5, 9, 42);
const base: TimeFormatOptions = { zone: 'UTC', dateFormat: 'YYYY-MM-DD', clock24h: true };

describe('date format', () => {
  it('writes the date in every supported format', () => {
    expect(formatDate(TS, base)).toBe('2026-03-31');
    expect(formatDate(TS, { ...base, dateFormat: 'DD.MM.YYYY' })).toBe('31.03.2026');
    expect(formatDate(TS, { ...base, dateFormat: 'DD/MM/YYYY' })).toBe('31/03/2026');
    expect(formatDate(TS, { ...base, dateFormat: 'MM/DD/YYYY' })).toBe('03/31/2026');
  });
});

describe('clock', () => {
  it('24-hour and 12-hour clocks, with optional seconds and milliseconds', () => {
    expect(formatClock(TS, base)).toBe('14:05:09');
    expect(formatClock(TS, base, { ms: true })).toBe('14:05:09.042');
    expect(formatClock(TS, base, { seconds: false })).toBe('14:05');
    expect(formatClock(TS, { ...base, clock24h: false })).toBe('2:05:09 PM');
    expect(formatClock(Date.UTC(2026, 2, 31, 0, 30), { ...base, clock24h: false })).toBe(
      '12:30:00 AM',
    );
    expect(formatClock(Date.UTC(2026, 2, 31, 12, 0), { ...base, clock24h: false })).toBe(
      '12:00:00 PM',
    );
  });
  it('midnight is 00:00, not 24:00', () => {
    expect(formatClock(Date.UTC(2026, 2, 31, 0, 0, 1), base)).toBe('00:00:01');
  });
});

describe('time zone', () => {
  it('shifts the wall clock and can roll the date', () => {
    const karachi = { ...base, zone: 'Asia/Karachi' }; // UTC+5
    expect(formatClock(TS, karachi)).toBe('19:05:09');
    expect(formatDateTime(Date.UTC(2026, 2, 31, 20, 0), karachi)).toBe('2026-04-01 01:00:00');
  });
  it('falls back to UTC for an invalid zone', () => {
    expect(formatClock(TS, { ...base, zone: 'Not/AZone' })).toBe('14:05:09');
  });
});

describe('number format and privacy (Settings → General / Privacy)', () => {
  it('formats numbers with the chosen separators', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.50');
    expect(formatNumber(1234.5, 'de-DE')).toBe('1.234,50');
    expect(formatNumber(123456.78, 'en-IN')).toBe('1,23,456.78');
    expect(formatNumber(1234.5, 'fr-FR').replace(/\s/g, ' ')).toBe('1 234,50');
  });

  it('hides balances and masks account ids', () => {
    expect(formatMoney(-1234.5, { locale: 'en-US', hide: false })).toBe('−$1,234.50');
    expect(formatMoney(-1234.5, { locale: 'en-US', hide: true })).toBe(HIDDEN_MONEY);
    expect(maskAccount('paper-3505', true)).toBe('••••3505');
    expect(maskAccount('paper-3505', false)).toBe('paper-3505');
  });
});
