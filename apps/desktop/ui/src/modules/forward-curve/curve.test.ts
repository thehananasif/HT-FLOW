import { describe, expect, it } from 'vitest';
import {
  basis,
  calendarSpreads,
  CURVE_ROOTS,
  curveContracts,
  curveProviderFor,
  curveShape,
  nextRollInfo,
  registerCurveProvider,
  SimCurveProvider,
  simSpotAgo,
} from './curve';

const now = Date.parse('2026-11-04T12:00:00Z');
const root = (k: string) => CURVE_ROOTS.find((r) => r.key === k)!;

describe('forward curve', () => {
  it('lists expiries from the catalog roll rules', () => {
    expect(
      curveContracts(root('CL'), now)
        .slice(0, 3)
        .map((c) => c.code),
    ).toEqual(['CLZ6', 'CLF7', 'CLG7']);
    expect(
      curveContracts(root('ES'), now)
        .map((c) => c.code)
        .slice(0, 2),
    ).toEqual(['ESZ6', 'ESH7']);
    expect(curveContracts(root('GC'), now)[0]!.code).toBe('GCZ6');
    expect(curveContracts(root('BTC-Q'), now).map((c) => c.code)).toEqual([
      'BTCUSDT_261225',
      'BTCUSDT_270326',
      'BTCUSDT_270625',
      'BTCUSDT_270924',
    ]);
    const roll = nextRollInfo(root('CL'), now)!;
    expect([roll.from.code, roll.to.code]).toEqual(['CLZ6', 'CLF7']);
  });
  it('sim curve shape follows the carry sign and is deterministic', () => {
    for (const [k, shape] of [
      ['CL', 'backwardation'],
      ['GC', 'contango'],
      ['ES', 'contango'],
      ['BTC-Q', 'contango'],
    ] as const) {
      const r = root(k);
      const cs = curveContracts(r, now);
      const px = SimCurveProvider.prices(r, cs, now, 100)!;
      expect(curveShape(px.map((price) => ({ price }))), k).toBe(shape);
      expect(SimCurveProvider.prices(r, cs, now, 100)).toEqual(px);
    }
    expect(curveProviderFor(root('CL'))!.kind).toBe('sim');
  });
  it('a registered provider wins over Sim', () => {
    registerCurveProvider({
      id: 'test',
      label: 'T',
      kind: 'live',
      supports: (r) => r.key === 'NG',
      prices: () => [],
    });
    expect(curveProviderFor(root('NG'))!.id).toBe('test');
    expect(curveProviderFor(root('CL'))!.id).toBe('sim');
  });
  it('spreads, basis, shape, spot ago', () => {
    const sp = calendarSpreads([{ price: 10 }, { price: 9.5 }, { price: 9.7 }]);
    expect(sp[0]).toBeNull();
    expect(sp[1]).toBeCloseTo(-0.5);
    expect(sp[2]).toBeCloseTo(0.2);
    const b = basis(101, 100, 365);
    expect(b.abs).toBe(1);
    expect(b.annPct).toBeCloseTo(1);
    expect(curveShape([{ price: 100 }, { price: 100.05 }])).toBe('flat');
    expect(simSpotAgo(root('CL'), 70, 0, now)).toBe(70);
    expect(Math.abs(simSpotAgo(root('CL'), 70, 7, now) / 70 - 1)).toBeLessThanOrEqual(0.02);
  });
});
