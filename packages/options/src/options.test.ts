import { describe, expect, it } from 'vitest';
import {
  analyzeStrategy,
  applyDeribitTicker,
  buildTemplate,
  DAY_MS,
  DeribitChainSource,
  findContract,
  generateSimChain,
  greeks,
  impliedVol,
  maxPain,
  normCdf,
  optionPrice,
  optionsPositionPayoff,
  optionsRiskProfile,
  parseDeribitChain,
  pnlAtExpiry,
  SIM_UNDERLYINGS,
  simExpiries,
  strikeLevels,
  strikesAround,
  volatilitySmiles,
  YEAR_MS,
  type Leg,
  type OptionParams,
  type StrategyEnv,
  type TemplateId,
} from './index';
import instrumentsFx from './deribit/fixtures/get_instruments.BTC.option.json';
import summaryFx from './deribit/fixtures/get_book_summary_by_currency.BTC.option.json';
import futuresFx from './deribit/fixtures/get_book_summary_by_currency.BTC.future.json';
import tickerCallFx from './deribit/fixtures/ticker.BTC-27NOV26-80000-C.json';
import tickerFutFx from './deribit/fixtures/ticker.BTC-27NOV26.json';

const within = (actual: number, ref: number, pct = 0.5) =>
  expect(Math.abs(actual - ref)).toBeLessThanOrEqual((Math.abs(ref) * pct) / 100 + 1e-12);

describe('normal distribution', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 14);
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 13);
    expect(normCdf(-1.96)).toBeCloseTo(0.024997895148220435, 13);
    expect(normCdf(3)).toBeCloseTo(0.9986501019683699, 13);
    expect(normCdf(-5) / 2.866515718791939e-7).toBeCloseTo(1, 10);
    expect(normCdf(-8) / 6.220960574271785e-16).toBeCloseTo(1, 6);
  });
});

/**
 * Reference values. Published ones: Hull, "Options, Futures and Other Derivatives" — example 15.6
 * (c = 4.76, p = 0.81), the Greek-letters example S=49 K=50 (Δ 0.522, Γ 0.066, Θ −4.31/yr,
 * vega 12.1, ρ 8.91) and the Black-76 crude put (1.12); Haug, "Option Pricing Formulas" —
 * 2.1334, 1.7011, 2.4648, Δ 0.5946 / −0.3566, Γ 0.0278, vega 18.9358, Θ −31.1924, ρ 38.7325.
 * The 6-digit figures below come from an independent reference calculator (Python, math.erfc)
 * that reproduces every published figure above.
 */
type Ref = [string, OptionParams, { price: number; delta: number; gamma: number; thetaYr: number; vega: number; rho: number }];
const o = (kind: 'call' | 'put', S: number, K: number, T: number, r: number, q: number, sigma: number, model: 'bs' | 'b76' = 'bs'): OptionParams => ({ kind, S, K, T, r, q, sigma, model });
const REFS: Ref[] = [
  ['Hull 15.6 call', o('call', 42, 40, 0.5, 0.1, 0, 0.2), { price: 4.759422, delta: 0.779131, gamma: 0.049963, thetaYr: -4.559092, vega: 8.813415, rho: 13.982046 }],
  ['Hull 15.6 put', o('put', 42, 40, 0.5, 0.1, 0, 0.2), { price: 0.808599, delta: -0.220869, gamma: 0.049963, thetaYr: -0.754174, vega: 8.813415, rho: -5.042543 }],
  ['Hull Greeks call', o('call', 49, 50, 20 / 52, 0.05, 0, 0.2), { price: 2.400527, delta: 0.521605, gamma: 0.065544, thetaYr: -4.30533, vega: 12.10548, rho: 8.906962 }],
  ['Hull Black-76 put', o('put', 20, 20, 4 / 12, 0.09, 0, 0.25, 'b76'), { price: 1.116641, delta: -0.457307, gamma: 0.133765, thetaYr: -1.571559, vega: 4.458817, rho: -0.372214 }],
  ['Haug GBSM call', o('call', 60, 65, 0.25, 0.08, 0, 0.3), { price: 2.133368, delta: 0.372483, gamma: 0.042043, thetaYr: -8.428174, vega: 11.351544, rho: 5.0539 }],
  ['Haug Black-76 call', o('call', 19, 19, 0.75, 0.1, 0, 0.28, 'b76'), { price: 1.701051, delta: 0.508636, gamma: 0.079745, thetaYr: -0.958383, vega: 6.045471, rho: -1.275788 }],
  ['Haug Merton put (q=5%)', o('put', 100, 95, 0.5, 0.1, 0.05, 0.2), { price: 2.464788, delta: -0.264182, gamma: 0.02284, thetaYr: -3.000528, vega: 22.839574, rho: -14.441474 }],
  ['Haug futures call', o('call', 105, 100, 0.5, 0.1, 0, 0.36, 'b76'), { price: 12.432845, delta: 0.594629, gamma: 0.013494, thetaYr: -8.39684, vega: 26.778123, rho: -6.216422 }],
  ['Haug futures put', o('put', 105, 100, 0.5, 0.1, 0, 0.36, 'b76'), { price: 7.676697, delta: -0.356601, gamma: 0.013494, thetaYr: -8.872454, vega: 26.778123, rho: -3.838349 }],
  ['Haug gamma/vega', o('call', 55, 60, 0.75, 0.1, 0, 0.3), { price: 5.392779, delta: 0.533341, gamma: 0.027821, thetaYr: -6.181255, vega: 18.935777, rho: 17.955748 }],
  ['Haug theta put (b=2%)', o('put', 430, 405, 0.0833, 0.07, 0.05, 0.2), { price: 1.75602, delta: -0.136103, gamma: 0.008785, thetaYr: -31.192367, vega: 27.060652, rho: -5.021359 }],
  ['Haug rho call', o('call', 72, 75, 1, 0.09, 0, 0.19), { price: 7.222752, delta: 0.638267, gamma: 0.027393, thetaYr: -6.049111, vega: 26.980899, rho: 38.732505 }],
];

describe('Black-Scholes / Black-76 price and Greeks', () => {
  for (const [name, p, ref] of REFS) {
    it(`${name}: within 0.5 % of the reference`, () => {
      const g = greeks(p);
      within(optionPrice(p), ref.price);
      within(g.price, ref.price);
      within(g.delta, ref.delta);
      within(g.gamma, ref.gamma);
      within(g.theta * 365, ref.thetaYr);
      within(g.vega * 100, ref.vega);
      within(g.rho * 100, ref.rho);
    });
  }

  it('satisfies put-call parity and gamma/vega symmetry', () => {
    for (const model of ['bs', 'b76'] as const)
      for (const K of [60, 100, 140])
        for (const T of [0.02, 0.5, 2]) {
          const p = { S: 100, K, T, r: 0.05, q: 0.02, sigma: 0.3, model };
          const c = greeks({ ...p, kind: 'call' });
          const put = greeks({ ...p, kind: 'put' });
          const fwd = model === 'b76' ? 100 * Math.exp(-0.05 * T) : 100 * Math.exp(-0.02 * T);
          expect(c.price - put.price).toBeCloseTo(fwd - K * Math.exp(-0.05 * T), 9);
          expect(c.gamma).toBeCloseTo(put.gamma, 12);
          expect(c.vega).toBeCloseTo(put.vega, 12);
          expect(c.delta - put.delta).toBeCloseTo(fwd / 100, 10);
        }
  });

  it('Greeks agree with finite differences', () => {
    const p: OptionParams = { kind: 'put', S: 6850, K: 6800, T: 0.15, r: 0.04, sigma: 0.17, model: 'b76' };
    const g = greeks(p);
    const h = 0.01;
    const d = (optionPrice({ ...p, S: p.S + h }) - optionPrice({ ...p, S: p.S - h })) / (2 * h);
    const gm = (optionPrice({ ...p, S: p.S + h }) - 2 * optionPrice(p) + optionPrice({ ...p, S: p.S - h })) / (h * h);
    const v = optionPrice({ ...p, sigma: p.sigma + 0.005 }) - optionPrice({ ...p, sigma: p.sigma - 0.005 });
    const th = optionPrice({ ...p, T: p.T - 0.5 / 365 }) - optionPrice({ ...p, T: p.T + 0.5 / 365 });
    const rh = optionPrice({ ...p, r: p.r + 0.005 }) - optionPrice({ ...p, r: p.r - 0.005 });
    within(g.delta, d, 0.01);
    within(g.gamma, gm, 0.1);
    within(g.vega, v, 0.01);
    within(g.theta, th, 0.05);
    within(g.rho, rh, 0.01);
  });

  it('handles expiry and zero volatility', () => {
    expect(optionPrice({ kind: 'call', S: 105, K: 100, T: 0, r: 0.05, sigma: 0.2 })).toBe(5);
    expect(greeks({ kind: 'put', S: 105, K: 100, T: 0, r: 0.05, sigma: 0.2 }).delta).toBe(0);
    expect(optionPrice({ kind: 'call', S: 100, K: 90, T: 1, r: 0, sigma: 0, model: 'b76' })).toBeCloseTo(10, 9);
  });
});

describe('implied volatility', () => {
  it('reproduces Hull: c = 1.875, S = 21, K = 20, r = 10 %, T = 0.25 → 23.5 %', () => {
    const iv = impliedVol({ kind: 'call', S: 21, K: 20, T: 0.25, r: 0.1, price: 1.875 });
    expect(iv).toBeCloseTo(0.234513, 5);
  });

  it('round-trips across deep ITM/OTM, short and long expiries, both models', () => {
    let tested = 0;
    for (const model of ['bs', 'b76'] as const)
      for (const kind of ['call', 'put'] as const)
        for (const K of [30, 50, 80, 95, 100, 105, 125, 200, 300])
          for (const T of [1 / 365, 7 / 365, 0.25, 1, 5])
            for (const sigma of [0.05, 0.2, 0.5, 1.5]) {
              const p = { kind, S: 100, K, T, r: 0.03, q: 0.01, model };
              const price = optionPrice({ ...p, sigma });
              // Skip quotes whose time value is below double precision (no solver can recover them).
              const otm = optionPrice({ ...p, sigma, kind: K > 100 ? 'call' : 'put' });
              if (otm < 1e-9) continue;
              const iv = impliedVol({ ...p, price });
              expect(Math.abs(iv - sigma)).toBeLessThan(1e-5 * sigma + 1e-7);
              tested++;
            }
    expect(tested).toBeGreaterThan(400);
  });

  it('returns NaN outside the no-arbitrage bounds', () => {
    expect(impliedVol({ kind: 'call', S: 100, K: 80, T: 0.5, r: 0, price: 19 })).toBeNaN();
    expect(impliedVol({ kind: 'call', S: 100, K: 80, T: 0.5, r: 0, price: 101 })).toBeNaN();
    expect(impliedVol({ kind: 'put', S: 100, K: 80, T: 0, r: 0, price: 1 })).toBeNaN();
  });
});

const NOW = Date.UTC(2026, 10, 4, 12);
const EXP = NOW + 30 * DAY_MS;
const env: StrategyEnv = { model: 'b76', r: 0, multiplier: 1, now: NOW };
const leg = (kind: 'call' | 'put', strike: number, qty: number, premium: number, expiry = EXP): Leg => ({
  id: `${kind}${strike}${qty}`, kind, strike, expiry, qty, premium, iv: 0.3,
});
const payoff = (legs: Leg[], prices: number[]) => prices.map((p) => +pnlAtExpiry(legs, p, env).toFixed(6));

describe('strategies: payoff, breakevens, max profit/loss', () => {
  it('long call', () => {
    const legs = [leg('call', 100, 1, 5)];
    expect(payoff(legs, [80, 100, 105, 120])).toEqual([-5, -5, 0, 15]);
    const a = analyzeStrategy(legs, 100, env);
    expect(a.maxProfit).toBe(Infinity);
    expect(a.maxLoss).toBeCloseTo(-5, 9);
    expect(a.breakevens[0]).toBeCloseTo(105, 6);
    expect(a.netPremium).toBe(-5);
  });
  it('short put', () => {
    const legs = [leg('put', 100, -1, 4)];
    expect(payoff(legs, [0, 90, 96, 100, 130])).toEqual([-96, -6, 0, 4, 4]);
    const a = analyzeStrategy(legs, 100, env);
    expect(a.maxProfit).toBeCloseTo(4, 9);
    expect(a.maxLoss).toBeCloseTo(-96, 9);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeCloseTo(96, 6);
  });
  it('long straddle', () => {
    const legs = [leg('call', 100, 1, 5), leg('put', 100, 1, 4)];
    expect(payoff(legs, [80, 91, 100, 109, 125])).toEqual([11, 0, -9, 0, 16]);
    const a = analyzeStrategy(legs, 100, env);
    expect(a.maxProfit).toBe(Infinity);
    expect(a.maxLoss).toBeCloseTo(-9, 9);
    expect(a.breakevens.map((b) => +b.toFixed(4))).toEqual([91, 109]);
  });
  it('short strangle has unlimited loss', () => {
    const legs = [leg('put', 90, -1, 2), leg('call', 110, -1, 2)];
    expect(payoff(legs, [80, 86, 100, 114, 130])).toEqual([-6, 0, 4, 0, -16]);
    const a = analyzeStrategy(legs, 100, env);
    expect(a.maxLoss).toBe(-Infinity);
    expect(a.maxProfit).toBeCloseTo(4, 9);
  });
  it('bull call spread', () => {
    const legs = [leg('call', 100, 1, 6), leg('call', 110, -1, 2)];
    expect(payoff(legs, [90, 100, 104, 110, 150])).toEqual([-4, -4, 0, 6, 6]);
    const a = analyzeStrategy(legs, 100, env);
    expect([a.maxProfit, a.maxLoss].map((v) => +v.toFixed(6))).toEqual([6, -4]);
    expect(a.breakevens[0]).toBeCloseTo(104, 6);
  });
  it('bear put spread', () => {
    const legs = [leg('put', 100, 1, 5), leg('put', 90, -1, 2)];
    expect(payoff(legs, [70, 90, 97, 100, 120])).toEqual([7, 7, 0, -3, -3]);
  });
  it('iron condor', () => {
    const legs = [leg('put', 90, -1, 3), leg('put', 85, 1, 1.5), leg('call', 110, -1, 3), leg('call', 115, 1, 1.5)];
    expect(payoff(legs, [70, 85, 87, 100, 113, 115, 140])).toEqual([-2, -2, 0, 3, 0, -2, -2]);
    const a = analyzeStrategy(legs, 100, env);
    expect([a.maxProfit, a.maxLoss, a.netPremium].map((v) => +v.toFixed(6))).toEqual([3, -2, 3]);
    expect(a.breakevens.map((b) => +b.toFixed(4))).toEqual([87, 113]);
    expect(a.pop).toBeGreaterThan(0.5);
    expect(a.pop).toBeLessThan(1);
  });
  it('butterfly', () => {
    const legs = [leg('call', 90, 1, 12), leg('call', 100, -2, 5), leg('call', 110, 1, 1)];
    expect(payoff(legs, [80, 90, 93, 100, 107, 110, 130])).toEqual([-3, -3, 0, 7, 0, -3, -3]);
    const a = analyzeStrategy(legs, 100, env);
    expect([a.maxProfit, a.maxLoss].map((v) => +v.toFixed(6))).toEqual([7, -3]);
  });
  it('ratio spread 1×2 has unlimited upside loss', () => {
    const legs = [leg('call', 100, 1, 5), leg('call', 110, -2, 2)];
    expect(payoff(legs, [90, 100, 110, 119, 130])).toEqual([-1, -1, 9, 0, -11]);
    expect(analyzeStrategy(legs, 100, env).maxLoss).toBe(-Infinity);
  });
  it('calendar: long far call keeps time value at the near expiry', () => {
    const far = EXP + 30 * DAY_MS;
    const legs = [leg('call', 100, -1, 3.4), leg('call', 100, 1, 4.8, far)];
    const a = analyzeStrategy(legs, 100, env);
    const atm = pnlAtExpiry(legs, 100, env);
    const farValue = optionPrice({ kind: 'call', S: 100, K: 100, T: 30 / 365, r: 0, sigma: 0.3, model: 'b76' });
    expect(atm).toBeCloseTo(farValue - 1.4, 9);
    expect(a.maxProfit).toBeCloseTo(atm, 2);
    expect(a.maxLoss).toBeGreaterThan(-1.41);
    expect(a.breakevens).toHaveLength(2);
  });
  it('probability of profit matches the lognormal closed form for a long call', () => {
    const legs = [leg('call', 100, 1, 5)];
    const a = analyzeStrategy(legs, 100, env);
    const tau = 30 / 365;
    const d = (Math.log(100 / 105) - (0.09 / 2) * tau) / (0.3 * Math.sqrt(tau));
    expect(a.pop).toBeCloseTo(normCdf(d), 6);
  });
  it('multiplier scales P/L and Greeks totals', () => {
    const legs = [leg('call', 100, 2, 5)];
    const a = analyzeStrategy(legs, 100, { ...env, multiplier: 50 });
    const g = greeks({ kind: 'call', S: 100, K: 100, T: 30 / 365, r: 0, sigma: 0.3, model: 'b76' });
    expect(a.greeks.delta).toBeCloseTo(100 * g.delta, 9);
    expect(a.greeks.theta).toBeCloseTo(100 * g.theta, 9);
    expect(a.netPremium).toBe(-500);
  });
  it('templates build the expected legs', () => {
    const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
    const t = (id: TemplateId) => buildTemplate(id, { strikes, spot: 101, expiries: [EXP + 5, EXP] }).map((l) => `${l.qty > 0 ? '+' : ''}${l.qty}${l.kind[0]}${l.strike}`);
    expect(t('long-straddle')).toEqual(['+1c100', '+1p100']);
    expect(t('short-strangle')).toEqual(['-1p95', '-1c105']);
    expect(t('bull-call-spread')).toEqual(['+1c100', '-1c105']);
    expect(t('bear-put-spread')).toEqual(['+1p100', '-1p95']);
    expect(t('iron-condor')).toEqual(['-1p95', '+1p90', '-1c105', '+1c110']);
    expect(t('butterfly')).toEqual(['+1c95', '-2c100', '+1c105']);
    expect(t('ratio-spread')).toEqual(['+1c100', '-2c105']);
    const cal = buildTemplate('calendar', { strikes, spot: 101, expiries: [EXP + 5, EXP] });
    expect(cal.map((l) => [l.qty, l.expiry])).toEqual([[-1, EXP], [1, EXP + 5]]);
  });
});

describe('simulated chain', () => {
  const es = SIM_UNDERLYINGS.find((u) => u.id === 'mock:ESZ6')!;
  const chain = generateSimChain(es, { bid: 6850, ask: 6850.25, bidSize: 12, askSize: 9, last: 6850.25 }, NOW, 0.04);
  it('is labelled Sim and lists regular, weekly and EOM series', () => {
    expect(chain.simulated).toBe(true);
    expect(chain.sourceLabel).toBe('Sim');
    const kinds = new Set(chain.expiries.map((e) => e.series));
    expect([...kinds].sort()).toEqual(['eom', 'regular', 'weekly']);
    expect(simExpiries(NOW, 'future').every((e) => e.expiry > NOW)).toBe(true);
    for (const e of chain.expiries.filter((x) => x.series !== 'eom')) expect(new Date(e.expiry).getUTCDay()).toBe(5);
  });
  it('has sane quotes: bid < ask on the tick grid, IVs bracket the mark, put skew', () => {
    const e = chain.expiries.find((x) => x.series === 'regular')!;
    for (const s of e.strikes)
      for (const c of [s.call!, s.put!]) {
        const q = c.quote;
        expect(q.ask!).toBeGreaterThan(q.bid ?? 0);
        expect(Math.abs(q.ask! / 0.05 - Math.round(q.ask! / 0.05))).toBeLessThan(1e-6);
        if (q.bidIv !== null && q.askIv !== null) {
          expect(q.bidIv).toBeLessThanOrEqual(q.markIv! + 1e-9);
          expect(q.askIv).toBeGreaterThanOrEqual(q.markIv! - 1e-9);
        }
      }
    const lowK = e.strikes[2]!.put!.quote.markIv!;
    const highK = e.strikes[e.strikes.length - 3]!.call!.quote.markIv!;
    expect(lowK).toBeGreaterThan(highK);
    expect(strikesAround(e.strikes, 6850.1, 5)).toHaveLength(9);
  });
  it('feeds the analytics: smile, strike levels, max pain', () => {
    const smiles = volatilitySmiles(chain);
    expect(smiles).toHaveLength(chain.expiries.length);
    expect(smiles[0]!.points.every((p) => p.iv === null || p.iv > 0)).toBe(true);
    const levels = strikeLevels(chain);
    expect(levels.reduce((a, l) => a + l.totalOi, 0)).toBeGreaterThan(0);
    const mp = maxPain(chain.expiries[0]!)!;
    expect(Math.abs(mp - 6850)).toBeLessThan(400);
  });
  it('crypto chain uses Black-Scholes forwards', () => {
    const btc = generateSimChain(SIM_UNDERLYINGS[0]!, null, NOW, 0.05);
    expect(btc.model).toBe('bs');
    const last = btc.expiries[btc.expiries.length - 1]!;
    expect(last.forward).toBeGreaterThan(btc.spot);
    expect(last.underlying.symbol).toMatch(/^BTC-\d+[A-Z]{3}\d\d$/);
  });
});

describe('analytics', () => {
  const legs = [leg('put', 90, -1, 3), leg('put', 85, 1, 1.5), leg('call', 110, -1, 3), leg('call', 115, 1, 1.5)];
  it('options position payoff: today converges to expiry', () => {
    const c = optionsPositionPayoff(legs, 100, env, { range: { from: 70, to: 130, steps: 61 } });
    expect(c.prices).toHaveLength(61);
    expect(c.expiry[30]).toBeCloseTo(3, 9);
    expect(c.now[30]!).toBeLessThan(3);
    const atExp = optionsPositionPayoff(legs, 100, env, { range: { from: 70, to: 130, steps: 61 }, at: EXP });
    expect(atExp.now).toEqual(atExp.expiry);
  });
  it('risk profile spans now → expiry', () => {
    const rp = optionsRiskProfile(legs, 100, env, { range: { from: 70, to: 130, steps: 13 }, timeSteps: 4 });
    expect(rp.pnl).toHaveLength(4);
    expect(rp.times[0]).toBe(NOW);
    expect(rp.times[3]).toBe(EXP);
    expect(rp.pnl[3]![6]).toBeCloseTo(3, 9);
    expect(rp.pnl[0]![6]!).toBeLessThan(rp.pnl[3]![6]!);
  });
});

describe('Deribit provider (recorded fixtures)', () => {
  const now = 1793826254902;
  const chain = parseDeribitChain('BTC', instrumentsFx, summaryFx, futuresFx, now);
  it('parses expiries, series types and strikes', () => {
    expect(chain.source).toBe('deribit');
    expect(chain.simulated).toBe(false);
    expect(chain.model).toBe('b76');
    expect(chain.expiries.map((e) => e.series)).toEqual(['daily', 'weekly', 'regular', 'regular']);
    const nov = chain.expiries[2]!;
    expect(nov.expiry).toBe(1795766400000);
    expect(nov.underlying.symbol).toBe('BTC-27NOV26');
    expect(nov.strikes).toHaveLength(12);
    expect(nov.strikes.every((s) => s.call && s.put)).toBe(true);
    expect(nov.underlying.bid).toBeGreaterThan(70000);
    expect(chain.spot).toBeGreaterThan(70000);
  });
  it('converts BTC quotes to USD and solves IVs consistent with the venue mark IV', () => {
    const c = findContract(chain, 'BTC-27NOV26-80000-C')!;
    const raw = (summaryFx.result as { instrument_name: string; bid_price: number | null; mark_iv: number; underlying_price: number; open_interest: number }[]).find((x) => x.instrument_name === c.name)!;
    expect(c.quote.bid).toBeCloseTo(raw.bid_price! * raw.underlying_price, 6);
    expect(c.quote.openInterest).toBe(raw.open_interest);
    expect(c.quote.markIv).toBeCloseTo(raw.mark_iv / 100, 9);
    expect(c.quote.bidIv!).toBeLessThan(c.quote.askIv!);
    expect(Math.abs((c.quote.bidIv! + c.quote.askIv!) / 2 - c.quote.markIv!)).toBeLessThan(0.02);
    const model = optionPrice({ kind: 'call', S: raw.underlying_price, K: 80000, T: (c.expiry - now) / YEAR_MS, r: 0, sigma: c.quote.markIv!, model: 'b76' });
    within(c.quote.mark!, model, 1);
  });
  it('merges tickers: sizes, venue IVs, underlying future', () => {
    const copy = parseDeribitChain('BTC', instrumentsFx, summaryFx, futuresFx, now);
    expect(applyDeribitTicker(copy, tickerCallFx)).toBe(true);
    const c = findContract(copy, 'BTC-27NOV26-80000-C')!;
    expect(c.quote.bidSize).toBe(2.1);
    expect(c.quote.askSize).toBe(45.4);
    expect(c.quote.bidIv).toBeCloseTo(0.3484, 9);
    expect(c.quote.askIv).toBeCloseTo(0.3586, 9);
    // Deribit's own delta is reproduced by Black-76 on its underlying price and mark IV.
    const g = greeks({ kind: 'call', S: 80331.68, K: 80000, T: (c.expiry - 1793826254902) / YEAR_MS, r: 0, sigma: 0.352, model: 'b76' });
    within(g.delta, tickerCallFx.result.greeks.delta, 0.5);
    within(g.vega, tickerCallFx.result.greeks.vega, 0.5);
    within(g.theta, tickerCallFx.result.greeks.theta, 0.5);
    expect(applyDeribitTicker(copy, tickerFutFx)).toBe(true);
    expect(copy.expiries[2]!.underlying.bidSize).toBe(8250);
    expect(copy.expiries[2]!.underlying.ask).toBe(80335);
  });
  it('loads through an injected fetchText and surfaces API errors', async () => {
    const urls: string[] = [];
    const src = new DeribitChainSource(async (url) => {
      urls.push(url);
      if (url.includes('kind=future')) return JSON.stringify(futuresFx);
      if (url.includes('get_instruments')) return JSON.stringify(instrumentsFx);
      if (url.includes('ticker')) return JSON.stringify(tickerCallFx);
      return JSON.stringify(summaryFx);
    }, () => now);
    const c = await src.load('BTC');
    expect(c.expiries).toHaveLength(4);
    expect(urls.some((u) => u.endsWith('/public/get_book_summary_by_currency?currency=BTC&kind=option'))).toBe(true);
    expect(await src.enrich(c, ['BTC-27NOV26-80000-C'])).toBe(1);
    const bad = new DeribitChainSource(async () => '{"jsonrpc":"2.0","error":{"message":"Invalid params","code":-32602}}');
    await expect(bad.load('XXX')).rejects.toThrow(/Invalid params/);
  });
});
