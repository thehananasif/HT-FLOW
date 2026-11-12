import { describe, expect, it } from 'vitest';
import {
  barRemainingMs,
  countdownLabel,
  formatCountdown,
  inferPeriod,
  realSlot,
  slotAtOrBefore,
  virtualSlot,
  zoneOffsetMin,
} from './time';

describe('bar countdown', () => {
  const M5 = 300_000;
  it('counts down to the bar close', () => {
    const open = 1_700_000_100_000 - (1_700_000_100_000 % M5);
    expect(barRemainingMs(open, M5, open)).toBe(M5);
    expect(barRemainingMs(open, M5, open + 60_000)).toBe(240_000);
    expect(barRemainingMs(open, M5, open + M5 - 1)).toBe(1);
  });
  it('rolls to the next period once the bar is past its close', () => {
    const open = 0;
    expect(barRemainingMs(open, M5, M5)).toBe(M5);
    expect(barRemainingMs(open, M5, M5 + 1000)).toBe(M5 - 1000);
  });
  it('is zero for invalid periods', () => {
    expect(barRemainingMs(0, 0, 10)).toBe(0);
  });
  it('formats mm:ss, h:mm:ss and days', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(65_000)).toBe('01:05');
    expect(formatCountdown(59_001)).toBe('01:00');
    expect(formatCountdown(3_600_000 + 62_000)).toBe('1:01:02');
    expect(formatCountdown(2 * 86_400_000 + 3_600_000)).toBe('2d 01:00');
  });
  it('labels only time bars', () => {
    expect(countdownLabel(0, null, 10)).toBeNull();
    expect(countdownLabel(undefined, 60_000, 10)).toBeNull();
    expect(countdownLabel(0, 60_000, 30_000)).toBe('00:30');
  });
});

describe('time zones', () => {
  it('UTC is zero, fixed zones have known offsets', () => {
    const jan = Date.UTC(2026, 0, 15, 12);
    const jul = Date.UTC(2026, 6, 15, 12);
    expect(zoneOffsetMin('UTC', jan)).toBe(0);
    expect(zoneOffsetMin('Asia/Tokyo', jan)).toBe(540);
    expect(zoneOffsetMin('America/New_York', jan)).toBe(-300);
    expect(zoneOffsetMin('America/New_York', jul)).toBe(-240);
    expect(zoneOffsetMin('Not/AZone', jan)).toBe(0);
  });
});

describe('gaps (time-proportional slots)', () => {
  // Bars every minute with a 10-minute hole between slot 2 and 3.
  const times = [0, 60_000, 120_000, 720_000, 780_000];
  const at = (i: number) => times[i]!;
  it('infers the period from the smallest gap', () => {
    expect(inferPeriod(at, times.length)).toBe(60_000);
  });
  it('places slots by time so gaps leave space', () => {
    expect(virtualSlot(at, 5, 4, 60_000)).toBe(4);
    expect(virtualSlot(at, 5, 3, 60_000)).toBe(3);
    expect(virtualSlot(at, 5, 2, 60_000)).toBe(-7);
    expect(virtualSlot(at, 5, 0, 60_000)).toBe(-9);
  });
  it('maps virtual positions back to the nearest real slot', () => {
    expect(realSlot(at, 5, 4, 60_000)).toBe(4);
    expect(realSlot(at, 5, -7, 60_000)).toBe(2);
    expect(realSlot(at, 5, -8.6, 60_000)).toBe(0);
    expect(realSlot(at, 5, 6, 60_000)).toBe(6);
  });
  it('binary-searches the slot at or before a time', () => {
    expect(slotAtOrBefore(at, 5, -1)).toBe(-1);
    expect(slotAtOrBefore(at, 5, 0)).toBe(0);
    expect(slotAtOrBefore(at, 5, 500_000)).toBe(2);
    expect(slotAtOrBefore(at, 5, 10_000_000)).toBe(4);
  });
});
