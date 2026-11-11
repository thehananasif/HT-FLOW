import {
  contractName,
  expiryCode,
  type ChainExpiry,
  type ChainLoadOptions,
  type ChainUnderlying,
  type OptionContract,
  type OptionsChain,
  type OptionsChainSource,
  type SeriesType,
  type UnderlyingQuote,
} from './chain';
import { impliedVol } from './iv';
import { DAY_MS, optionPrice, yearFrac, type OptionKind, type PricingModel } from './pricing';

/** Parameters of a simulated option market on one underlying. */
export interface SimUnderlying {
  /** Instrument id of the underlying feed, e.g. mock:ESZ6. */
  id: string;
  root: string;
  /** Underlying symbol shown in the quotes table (futures); crypto shows per-expiry forwards. */
  symbol: string;
  style: 'crypto' | 'future';
  model: PricingModel;
  /** Dividend / funding yield (bs), decimal. */
  q: number;
  multiplier: number;
  strikeStep: number;
  optionTick: number;
  priceDecimals: number;
  currency: string;
  /** Fallback price when the feed has no quote yet. */
  refPrice: number;
  /** ATM vol at very short maturities and in the long run (term structure), decimal. */
  shortVol: number;
  longVol: number;
  /** Smile in standardised moneyness x = ln(K/F)/(σ√T): σ(x) = σatm·(1 + skew·x + curvature·x²). */
  skew: number;
  curvature: number;
  /** Half bid/ask spread in vol points (decimal) at the money. */
  spreadVol: number;
  /** Open interest scale at the money. */
  oiScale: number;
  /** Max displayed size. */
  sizeScale: number;
}

export const SIM_UNDERLYINGS: SimUnderlying[] = [
  {
    id: 'mock:BTCUSDT',
    root: 'BTC',
    symbol: 'BTCUSDT',
    style: 'crypto',
    model: 'bs',
    q: 0,
    multiplier: 1,
    strikeStep: 1000,
    optionTick: 5,
    priceDecimals: 0,
    currency: 'USDT',
    refPrice: 68_200,
    shortVol: 0.46,
    longVol: 0.52,
    skew: -0.02,
    curvature: 0.05,
    spreadVol: 0.006,
    oiScale: 900,
    sizeScale: 25,
  },
  {
    id: 'mock:CLZ6',
    root: 'LO',
    symbol: 'CLZ6',
    style: 'future',
    model: 'b76',
    q: 0,
    multiplier: 1000,
    strikeStep: 0.5,
    optionTick: 0.01,
    priceDecimals: 2,
    currency: 'USD',
    refPrice: 91.5,
    shortVol: 0.34,
    longVol: 0.3,
    skew: -0.06,
    curvature: 0.04,
    spreadVol: 0.005,
    oiScale: 6000,
    sizeScale: 60,
  },
  {
    id: 'mock:GCZ6',
    root: 'OG',
    symbol: 'GCZ6',
    style: 'future',
    model: 'b76',
    q: 0,
    multiplier: 100,
    strikeStep: 25,
    optionTick: 0.1,
    priceDecimals: 1,
    currency: 'USD',
    refPrice: 4051,
    shortVol: 0.19,
    longVol: 0.2,
    skew: 0.03,
    curvature: 0.03,
    spreadVol: 0.004,
    oiScale: 3000,
    sizeScale: 40,
  },
  {
    id: 'mock:ESZ6',
    root: 'ES',
    symbol: 'ESZ6',
    style: 'future',
    model: 'b76',
    q: 0,
    multiplier: 50,
    strikeStep: 25,
    optionTick: 0.05,
    priceDecimals: 2,
    currency: 'USD',
    refPrice: 6850,
    shortVol: 0.14,
    longVol: 0.18,
    skew: -0.14,
    curvature: 0.03,
    spreadVol: 0.003,
    oiScale: 12000,
    sizeScale: 150,
  },
  {
    id: 'mock:NQZ6',
    root: 'NQ',
    symbol: 'NQZ6',
    style: 'future',
    model: 'b76',
    q: 0,
    multiplier: 20,
    strikeStep: 100,
    optionTick: 0.25,
    priceDecimals: 2,
    currency: 'USD',
    refPrice: 24_810,
    shortVol: 0.19,
    longVol: 0.22,
    skew: -0.12,
    curvature: 0.03,
    spreadVol: 0.004,
    oiScale: 4000,
    sizeScale: 40,
  },
];

export function simUnderlying(id: string): SimUnderlying | undefined {
  return SIM_UNDERLYINGS.find((u) => u.id === id);
}

/* ------------------------------------------------------------------ seeded randomness */

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ expiry calendar */

const utc = (y: number, m: number, d: number, h: number) => Date.UTC(y, m, d, h);

function lastWeekday(y: number, m: number, weekday: number, h: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return utc(y, m, last.getUTCDate() - back, h);
}

function nthWeekday(y: number, m: number, weekday: number, n: number, h: number): number {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return utc(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7, h);
}

function lastBusinessDay(y: number, m: number, h: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const dow = last.getUTCDay();
  const back = dow === 6 ? 1 : dow === 0 ? 2 : 0;
  return utc(y, m, last.getUTCDate() - back, h);
}

/**
 * Listed expiries of a simulated market: six weeklies (Fridays), six regular monthlies
 * (crypto: last Friday, futures: third Friday) and three end-of-month series (futures only).
 */
export function simExpiries(
  now: number,
  style: 'crypto' | 'future',
): { expiry: number; series: SeriesType }[] {
  const hour = style === 'crypto' ? 8 : 20;
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const out = new Map<number, SeriesType>();
  const add = (t: number, s: SeriesType) => {
    if (t <= now + 30 * 60_000) return;
    const day = Math.floor(t / DAY_MS);
    const prev = out.get(day);
    const rank: Record<SeriesType, number> = { regular: 3, eom: 2, weekly: 1, daily: 0 };
    if (prev === undefined || rank[s] > rank[prev]) out.set(day, s);
  };
  for (let i = 0; i < 7; i++) {
    const m = m0 + i;
    add(style === 'crypto' ? lastWeekday(y, m, 5, hour) : nthWeekday(y, m, 5, 3, hour), 'regular');
    if (style === 'future' && i < 4) add(lastBusinessDay(y, m, hour), 'eom');
  }
  const daysToFri = (5 - d.getUTCDay() + 7) % 7;
  for (let w = 0; w < 6; w++) add(utc(y, m0, d.getUTCDate() + daysToFri + 7 * w, hour), 'weekly');
  const list = [...out.entries()]
    .map(([day, series]) => ({ expiry: day * DAY_MS + hour * 3_600_000, series }))
    .sort((a, b) => a.expiry - b.expiry);
  const regular = list.filter((e) => e.series === 'regular').slice(0, 6);
  const eom = list.filter((e) => e.series === 'eom').slice(0, 3);
  const weekly = list.filter((e) => e.series === 'weekly');
  return [...regular, ...eom, ...weekly].sort((a, b) => a.expiry - b.expiry);
}

/* ------------------------------------------------------------------ chain generator */

export interface LiveUnderlyingQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
}

const roundTo = (v: number, step: number, mode: 'floor' | 'ceil' | 'round') => {
  const x = v / step;
  const n =
    mode === 'floor' ? Math.floor(x + 1e-9) : mode === 'ceil' ? Math.ceil(x - 1e-9) : Math.round(x);
  return +(n * step).toFixed(10);
};

/** Smile + term structure of the simulated market. */
export function simVol(u: SimUnderlying, K: number, F: number, T: number): number {
  const atm = u.longVol + (u.shortVol - u.longVol) * Math.exp(-T / 0.25);
  const x = Math.log(K / F) / (atm * Math.sqrt(Math.max(T, 1 / 365)));
  const v = atm * (1 + u.skew * x + u.curvature * x * x);
  return Math.min(atm * 3, Math.max(atm * 0.4, v));
}

/**
 * Builds a full simulated chain from the live underlying quote: per-expiry forwards, a strike
 * ladder around the money, smile/skew + term structure, tick-rounded bid/ask with spreads that widen
 * away from the money, implied vols solved from the rounded quotes, and seeded sizes/OI/volume.
 */
export function generateSimChain(
  u: SimUnderlying,
  live: LiveUnderlyingQuote | null,
  now: number,
  r = 0.04,
): OptionsChain {
  const mid =
    live?.bid != null && live.ask != null && live.bid > 0 && live.ask > 0
      ? (live.bid + live.ask) / 2
      : (live?.last ?? u.refPrice);
  const spot = mid > 0 ? mid : u.refPrice;
  const tick = u.optionTick;
  const sizeSeed = Math.floor(now / 3000);
  const expiries: ChainExpiry[] = simExpiries(now, u.style).map(({ expiry, series }) => {
    const T = yearFrac(now, expiry);
    const carry = u.model === 'bs' ? Math.exp((r - u.q) * T) : 1;
    const F = spot * carry;
    const scale = (v: number | null | undefined) => (v == null ? null : v * carry);
    const underlying: UnderlyingQuote =
      u.style === 'future'
        ? {
            symbol: u.symbol,
            bid: live?.bid ?? null,
            ask: live?.ask ?? null,
            bidSize: live?.bidSize ?? null,
            askSize: live?.askSize ?? null,
            last: live?.last ?? spot,
          }
        : {
            symbol: `${u.root}-${expiryCode(expiry)}`,
            bid: scale(live?.bid),
            ask: scale(live?.ask),
            bidSize: live?.bidSize ?? null,
            askSize: live?.askSize ?? null,
            last: scale(live?.last ?? spot),
          };
    const atmVol = simVol(u, F, F, T);
    const step = u.strikeStep;
    const n = Math.min(40, Math.max(10, Math.ceil((3.5 * atmVol * Math.sqrt(T) * F) / step)));
    const center = roundTo(F, step, 'round');
    const strikes = [];
    for (let i = -n; i <= n; i++) {
      const K = +(center + i * step).toFixed(8);
      if (K <= 0) continue;
      const vol = simVol(u, K, F, T);
      const x = Math.abs(Math.log(K / F)) / (atmVol * Math.sqrt(Math.max(T, 1 / 365)));
      const make = (kind: OptionKind): OptionContract => {
        const p = { kind, S: spot, K, T, r, q: u.q, model: u.model };
        const theo = optionPrice({ ...p, sigma: vol });
        const sv = u.spreadVol * (1 + 0.35 * x);
        let bid: number | null = roundTo(optionPrice({ ...p, sigma: vol - sv }), tick, 'floor');
        const ask = Math.max(tick, roundTo(optionPrice({ ...p, sigma: vol + sv }), tick, 'ceil'));
        if (bid >= ask) bid = ask - tick;
        if (bid < tick) bid = null;
        const stat = rng(`${u.root}|${expiry}|${K}|${kind}`);
        const live = rng(`${u.root}|${expiry}|${K}|${kind}|${sizeSeed}`);
        const round = Math.abs(K / (step * 4) - Math.round(K / (step * 4))) < 1e-9 ? 1.8 : 1;
        const oi = Math.round(u.oiScale * Math.exp((-x * x) / 2) * (0.4 + stat()) * round);
        const iv = (price: number | null) => {
          if (price === null) return null;
          const v = impliedVol({ ...p, price });
          return Number.isFinite(v) ? v : null;
        };
        return {
          name: contractName(u.root, expiry, K, kind),
          kind,
          strike: K,
          expiry,
          quote: {
            bid,
            ask,
            bidSize: bid === null ? null : 1 + Math.floor(live() * u.sizeScale),
            askSize: 1 + Math.floor(live() * u.sizeScale),
            last: Math.max(tick, roundTo(theo * (1 + (stat() - 0.5) * 0.04), tick, 'round')),
            volume: Math.round(oi * (0.03 + 0.25 * stat())),
            openInterest: oi,
            change: +((stat() - 0.5) * 24).toFixed(2),
            bidIv: iv(bid),
            askIv: iv(ask),
            markIv: vol,
            mark: theo,
          },
        };
      };
      strikes.push({ strike: K, call: make('call'), put: make('put') });
    }
    return { expiry, series, underlying, forward: F, strikes };
  });
  return {
    root: u.root,
    source: 'sim',
    sourceLabel: 'Sim',
    simulated: true,
    model: u.model,
    r,
    q: u.q,
    multiplier: u.multiplier,
    spot,
    priceDecimals: u.priceDecimals,
    currency: u.currency,
    expiries,
    updatedAt: now,
  };
}

/** Simulated chains for the MockFeed instruments (always labelled "Sim"). */
export class SimChainSource implements OptionsChainSource {
  readonly id = 'sim';
  readonly label = 'HT Sim';
  readonly simulated = true;
  constructor(
    private readonly quoteOf: (instrumentId: string) => LiveUnderlyingQuote | null,
    private readonly clock: () => number = Date.now,
  ) {}
  underlyings(): ChainUnderlying[] {
    return SIM_UNDERLYINGS.map((u) => ({ id: u.id, label: `${u.symbol} (Sim)` }));
  }
  async load(underlying: string, opts: ChainLoadOptions = {}): Promise<OptionsChain> {
    const u = simUnderlying(underlying);
    if (!u) throw new Error(`No simulated options for ${underlying}`);
    return generateSimChain(u, this.quoteOf(underlying), this.clock(), opts.r ?? 0.04);
  }
}
