import { describe, expect, it } from 'vitest';
import { paperOptionMark, type Leg } from '@htflow/options';
import { PaperEngine } from '@htflow/trading';
import { legToTrade } from './trade';

const exp = Date.UTC(2027, 2, 26, 8);
const chain = {
  model: 'b76' as const,
  spot: 100_000,
  r: 0,
  q: 0,
  multiplier: 1,
  expiries: [{ forward: 101_000 }, { forward: 102_000 }] as never,
};
const leg: Leg = {
  id: 'l',
  kind: 'call',
  strike: 110_000,
  expiry: exp,
  qty: -0.5,
  premium: 2_500,
  iv: 0.55,
  name: 'BTC-26MAR27-110000-C',
  basis: 102_000 / 101_000,
};

describe('Options Board → paper engine', () => {
  it('turns a leg into an options trade with the chain model inputs', () => {
    const req = legToTrade(leg, chain, 'paper-1', 'deribit:BTC')!;
    expect(req).toMatchObject({
      accountId: 'paper-1',
      underlyingId: 'deribit:BTC',
      right: 'call',
      side: 'sell',
      qty: 0.5,
      premium: 2_500,
      expiry: '2027-03-26',
      expiryTs: exp,
      model: 'b76',
      iv: 0.55,
    });
    expect(req.basis).toBeCloseTo(1.02); // forward / spot of the leg's own expiry
    expect(legToTrade({ ...leg, kind: 'underlying' }, chain, 'a', 'u')).toBeNull();
  });

  it('a sold call books a credit and marks to model in the paper engine', () => {
    const now = Date.UTC(2026, 10, 13);
    const eng = new PaperEngine({
      book: () => undefined,
      economics: () => ({ tickSize: 1, tickValue: 0 }),
      now: () => now,
    });
    eng.createAccount({ id: 'paper-1', name: 'P', startingBalance: 10_000 });
    const req = legToTrade(leg, chain, 'paper-1', 'deribit:BTC')!;
    const pos = eng.tradeOption(req);
    expect(typeof pos).not.toBe('string');
    expect(eng.optionFills[0]!.premiumFlow).toBe(1_250);
    eng.setOptionMarkModel((p) => paperOptionMark(p, 100_000, now));
    const m = eng.optionMark(eng.optionPositions()[0]!)!;
    expect(m).toBeGreaterThan(0);
    expect(eng.optionUnrealized('paper-1')).toBeCloseTo((2_500 - m) * 0.5);
  });
});
