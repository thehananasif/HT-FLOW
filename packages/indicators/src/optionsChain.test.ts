import { describe, expect, it } from 'vitest';
import type { OptionExpiryData, OptionStrikeData, OptionsData } from '@htflow/indicator-sdk';
import {
  atmIv,
  boardRows,
  compact,
  maxPainStrike,
  pickExpiry,
  smileLayout,
  smilePoints,
} from './optionsChain';

const k = (
  strike: number,
  callOi: number,
  putOi: number,
  callIv: number | null = null,
  putIv: number | null = null,
): OptionStrikeData => ({
  strike,
  callOi,
  putOi,
  callVolume: callOi / 10,
  putVolume: putOi / 10,
  callIv,
  putIv,
});

describe('max pain', () => {
  it('minimises the total payout to option holders', () => {
    // Calls pile up at 110, puts at 90: settling at 100 pays out the least.
    const strikes = [k(90, 0, 100), k(100, 10, 10), k(110, 100, 0)];
    expect(maxPainStrike(strikes)).toBe(100);
  });
  it('is pulled to the strike with the most open interest and handles empty chains', () => {
    // 500 calls at 90 are only worth anything above 90, so settling there is cheapest.
    expect(maxPainStrike([k(90, 500, 0), k(100, 0, 0), k(110, 0, 10)])).toBe(90);
    expect(maxPainStrike([])).toBeNull();
  });
  it('ties go to the lower strike', () => {
    expect(maxPainStrike([k(100, 0, 0), k(110, 0, 0)])).toBe(100);
  });
});

describe('board rows', () => {
  const strikes = [k(80, 1, 5), k(90, 2, 4), k(100, 8, 6, 0.5, 0.52), k(110, 3, 1), k(120, 0, 0)];
  it('takes the strikes nearest to spot, ascending', () => {
    const r = boardRows(strikes, 101, 3);
    expect(r.map((x) => x.strike)).toEqual([90, 100, 110]);
  });
  it('sums OI / volume, averages IV and computes put/call ratio', () => {
    const r = boardRows(strikes, 100, 1)[0]!;
    expect(r).toMatchObject({ strike: 100, oi: 14 });
    expect(r.volume).toBeCloseTo(1.4);
    expect(r.iv).toBeCloseTo(0.51);
    expect(r.pcr).toBeCloseTo(0.75);
    expect(boardRows(strikes, 120, 1)[0]!.pcr).toBeNull();
    expect(boardRows(strikes, 120, 1)[0]!.iv).toBeNull();
  });
});

describe('expiry pick', () => {
  const e = (expiry: number): OptionExpiryData => ({ expiry, forward: 100, strikes: [] });
  const d = { expiries: [e(10), e(20), e(30)] } as unknown as OptionsData;
  it('skips expired series and clamps', () => {
    expect(pickExpiry(d, 1, 15)!.expiry).toBe(20);
    expect(pickExpiry(d, 9, 15)!.expiry).toBe(30);
    expect(pickExpiry(d, 1, 99)!.expiry).toBe(10);
  });
});

describe('smile', () => {
  const e: OptionExpiryData = {
    expiry: 1,
    forward: 100,
    strikes: [
      k(70, 0, 0, 0.3, 0.9),
      k(90, 0, 0, 0.4, 0.6),
      k(100, 0, 0, 0.5, 0.5),
      k(110, 0, 0, 0.55, null),
      k(130, 0, 0, null, null),
    ],
  };
  it('uses puts below the forward, calls above, within the range, skipping gaps', () => {
    const p = smilePoints(e, 15);
    expect(p).toEqual([
      { strike: 90, iv: 0.6 },
      { strike: 100, iv: 0.5 },
      { strike: 110, iv: 0.55 },
    ]);
    expect(smilePoints(e, 50).map((x) => x.strike)).toEqual([70, 90, 100, 110]);
  });
  it('ATM IV is the point nearest the forward', () => {
    expect(atmIv(smilePoints(e, 15), 100)).toBe(0.5);
    expect(atmIv([], 100)).toBeNull();
  });
  it('maps IV onto the bars left of the last bar', () => {
    const l = smileLayout([smilePoints(e, 15)], 100, 40);
    expect(l.min).toBe(0.5);
    expect(l.max).toBe(0.6);
    expect(l.bars[0]).toEqual([100, 60, 80]);
    expect(smileLayout([[{ strike: 1, iv: 0.4 }]], 50, 10).bars[0]).toEqual([50]);
  });
});

describe('formatting', () => {
  it('compacts counts', () => {
    expect([compact(950), compact(1234), compact(3_400_000)]).toEqual(['950', '1.2k', '3.4M']);
  });
});
