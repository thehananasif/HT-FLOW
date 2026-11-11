import { catalog, listContracts, nextRoll, type ContractSpec } from '@htflow/market-catalog';

/**
 * Forward curve data model (P19 / P41). Expiries come from the market catalog's roll rules.
 * Prices come from a CurveProvider. No free futures-curve data exists, so the only provider
 * today is the clearly labelled simulated term structure (SimCurveProvider); a real provider
 * (CME via the user's Rithmic/CQG/dxFeed feed, Binance/OKX/Deribit quarterlies for crypto)
 * registers with registerCurveProvider() and wins over Sim.
 */

export interface CurveRoot {
  key: string;
  label: string;
  /** Catalog root used for name / contract rules. */
  catalogId: string;
  /** Contract rules (defaults to the catalog entry's). */
  spec?: ContractSpec;
  /** Contract label style. */
  style: 'futures' | 'crypto-quarterly';
  /** Feed id giving the spot / front reference price (if any). */
  spotFeed: string | null;
  /** Reference price when no feed is streaming. */
  refPrice: number;
  /** Simulated annualised carry: >0 contango, <0 backwardation. */
  carry: number;
  /** Simulated seasonal amplitude (fraction), peaking in January. */
  season: number;
  crypto: boolean;
  precision: number;
}

export const CURVE_ROOTS: CurveRoot[] = [
  {
    key: 'CL',
    label: 'CL',
    catalogId: 'cat:NYMEX:CL',
    style: 'futures',
    spotFeed: 'mock:CLZ6',
    refPrice: 70,
    carry: -0.07,
    season: 0,
    crypto: false,
    precision: 2,
  },
  {
    key: 'NG',
    label: 'NG',
    catalogId: 'cat:NYMEX:NG',
    style: 'futures',
    spotFeed: null,
    refPrice: 3.6,
    carry: 0.06,
    season: 0.12,
    crypto: false,
    precision: 3,
  },
  {
    key: 'GC',
    label: 'GC',
    catalogId: 'cat:COMEX:GC',
    style: 'futures',
    spotFeed: 'mock:GCZ6',
    refPrice: 4050,
    carry: 0.045,
    season: 0,
    crypto: false,
    precision: 1,
  },
  {
    key: 'ES',
    label: 'ES',
    catalogId: 'cat:CME:ES',
    style: 'futures',
    spotFeed: 'mock:ESZ6',
    refPrice: 6850,
    carry: 0.015,
    season: 0,
    crypto: false,
    precision: 2,
  },
  {
    key: 'BTC-CME',
    label: 'BTC (CME)',
    catalogId: 'cat:CME:BTC',
    style: 'futures',
    spotFeed: 'mock:BTCUSDT',
    refPrice: 68000,
    carry: 0.08,
    season: 0,
    crypto: true,
    precision: 0,
  },
  {
    key: 'BTC-Q',
    label: 'BTC quarterly',
    catalogId: 'cat:BINANCE-FUTURES:BTCUSDT',
    spec: {
      cycle: 'HMUZ',
      expiry: { kind: 'lastWeekday', weekday: 5 },
      roll: { kind: 'date', daysBefore: 3 },
      backAdjust: false,
      listed: 4,
    },
    style: 'crypto-quarterly',
    spotFeed: 'mock:BTCUSDT',
    refPrice: 68000,
    carry: 0.07,
    season: 0,
    crypto: true,
    precision: 1,
  },
];

export interface CurveContract {
  code: string;
  expiry: Date;
  /** Calendar days from "now" to expiry. */
  days: number;
}

export interface CurvePoint extends CurveContract {
  price: number;
}

export interface CurveProvider {
  id: string;
  label: string;
  kind: 'sim' | 'live' | 'delayed';
  supports(root: CurveRoot): boolean;
  /** Prices for `contracts` as of `asOf` (ms), given the spot reference at that time. */
  prices(root: CurveRoot, contracts: CurveContract[], asOf: number, spot: number): number[] | null;
}

const providers: CurveProvider[] = [];

export function registerCurveProvider(p: CurveProvider): void {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers[i] = p;
  else providers.unshift(p);
}

/** First registered provider that serves the root (Sim is registered last → fallback). */
export function curveProviderFor(root: CurveRoot): CurveProvider | undefined {
  return providers.find((p) => p.supports(root));
}

const DAY = 86_400_000;

export function rootSpec(root: CurveRoot): ContractSpec | undefined {
  return root.spec ?? catalog().get(root.catalogId)?.contract;
}

function contractLabel(root: CurveRoot, year: number, month: number, expiry: Date, code: string) {
  if (root.style !== 'crypto-quarterly') return code;
  const yy = String(year % 100).padStart(2, '0');
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(expiry.getUTCDate()).padStart(2, '0');
  return `BTCUSDT_${yy}${mm}${dd}`;
}

/** Listed contracts at `now` from the catalog roll rules. */
export function curveContracts(root: CurveRoot, now: number): CurveContract[] {
  const spec = rootSpec(root);
  if (!spec) return [];
  const rootSym = catalog().get(root.catalogId)?.root ?? root.key;
  return listContracts(rootSym, spec, new Date(now), spec.listed).map((c) => ({
    code: contractLabel(root, c.year, c.month, c.expiry, c.code),
    expiry: c.expiry,
    days: Math.max(0, (c.expiry.getTime() - now) / DAY),
  }));
}

export function nextRollInfo(root: CurveRoot, now: number) {
  const spec = rootSpec(root);
  if (!spec) return null;
  const r = nextRoll(catalog().get(root.catalogId)?.root ?? root.key, spec, new Date(now));
  if (!r || root.style !== 'crypto-quarterly') return r;
  const lbl = (c: typeof r.from) => contractLabel(root, c.year, c.month, c.expiry, c.code);
  return { ...r, from: { ...r.from, code: lbl(r.from) }, to: { ...r.to, code: lbl(r.to) } };
}

/** Deterministic pseudo-random in [-1, 1] from a string. */
export function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Simulated term structure: spot × e^(carry·T) × seasonal factor, tiny per-contract noise. */
export const SimCurveProvider: CurveProvider = {
  id: 'sim',
  label: 'Simulated term structure',
  kind: 'sim',
  supports: () => true,
  prices(root, contracts, asOf, spot) {
    const dayKey = Math.floor(asOf / DAY);
    const carry = root.carry + hashUnit(`${root.key}:carry:${dayKey}`) * 0.004;
    return contracts.map((c) => {
      const t = Math.max(0, (c.expiry.getTime() - asOf) / DAY / 365);
      const m = c.expiry.getUTCMonth();
      const seasonal = 1 + root.season * Math.cos((2 * Math.PI * m) / 12);
      const noise = 1 + hashUnit(`${root.key}:${c.code}`) * 0.0006;
      return spot * Math.exp(carry * t) * seasonal * noise;
    });
  },
};
registerCurveProvider(SimCurveProvider);

/** Simulated spot N days ago (deterministic random walk, ~2% per sqrt-week). */
export function simSpotAgo(root: CurveRoot, spot: number, days: number, now: number): number {
  if (days <= 0) return spot;
  const shock = hashUnit(`${root.key}:ago:${days}:${Math.floor(now / DAY)}`);
  return spot * (1 + shock * 0.02 * Math.sqrt(days / 7));
}

export type CurveShape = 'contango' | 'backwardation' | 'flat';

/** Curve shape from the front-to-back change (±0.1 % dead band). */
export function curveShape(points: readonly { price: number }[]): CurveShape {
  if (points.length < 2) return 'flat';
  const a = points[0]!.price;
  const b = points[points.length - 1]!.price;
  const rel = (b - a) / a;
  return rel > 0.001 ? 'contango' : rel < -0.001 ? 'backwardation' : 'flat';
}

/** Calendar spreads: each contract minus the previous one (first is null). */
export function calendarSpreads(points: readonly { price: number }[]): (number | null)[] {
  return points.map((p, i) => (i ? p.price - points[i - 1]!.price : null));
}

/** Basis vs spot: absolute and annualised % ((F/S − 1) × 365 / days). */
export function basis(price: number, spot: number, days: number): { abs: number; annPct: number } {
  const abs = price - spot;
  return { abs, annPct: days > 0.5 ? ((price / spot - 1) * 365 * 100) / days : Number.NaN };
}
