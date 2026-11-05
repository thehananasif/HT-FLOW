import type { OptionKind } from './pricing';

export type TemplateId =
  | 'long-call'
  | 'short-call'
  | 'long-put'
  | 'short-put'
  | 'long-straddle'
  | 'short-straddle'
  | 'long-strangle'
  | 'short-strangle'
  | 'bull-call-spread'
  | 'bear-call-spread'
  | 'bull-put-spread'
  | 'bear-put-spread'
  | 'iron-condor'
  | 'butterfly'
  | 'calendar'
  | 'ratio-spread';

export interface TemplateDef {
  id: TemplateId;
  label: string;
  /** Needs two expiries (calendar). */
  twoExpiries?: boolean;
}

export const TEMPLATES: TemplateDef[] = [
  { id: 'long-call', label: 'Long Call' },
  { id: 'short-call', label: 'Short Call' },
  { id: 'long-put', label: 'Long Put' },
  { id: 'short-put', label: 'Short Put' },
  { id: 'long-straddle', label: 'Long Straddle' },
  { id: 'short-straddle', label: 'Short Straddle' },
  { id: 'long-strangle', label: 'Long Strangle' },
  { id: 'short-strangle', label: 'Short Strangle' },
  { id: 'bull-call-spread', label: 'Bull Call Spread' },
  { id: 'bear-call-spread', label: 'Bear Call Spread' },
  { id: 'bull-put-spread', label: 'Bull Put Spread' },
  { id: 'bear-put-spread', label: 'Bear Put Spread' },
  { id: 'iron-condor', label: 'Iron Condor' },
  { id: 'butterfly', label: 'Butterfly' },
  { id: 'calendar', label: 'Calendar', twoExpiries: true },
  { id: 'ratio-spread', label: 'Ratio Spread (1×2)' },
];

/** A leg without prices: the caller fills premium / IV from the chain or the model. */
export interface LegSpec {
  kind: OptionKind;
  strike: number;
  expiry: number;
  /** Signed quantity: + buy, − sell. */
  qty: number;
}

export interface TemplateEnv {
  /** Available strikes (any order). */
  strikes: readonly number[];
  spot: number;
  /** Available expiries (any order); the nearest is used, calendars also use the next one. */
  expiries: readonly number[];
  /** Contracts per unit leg (default 1). */
  qty?: number;
  /** Distance between the strikes of a spread, in strike steps (default 1; strangles and condors use 2× for the short strikes). */
  width?: number;
}

/** Index of the strike nearest to spot in an ascending list. */
export function atmIndex(strikes: readonly number[], spot: number): number {
  let best = 0;
  for (let i = 1; i < strikes.length; i++)
    if (Math.abs(strikes[i]! - spot) < Math.abs(strikes[best]! - spot)) best = i;
  return best;
}

/** Builds the legs of a template around the at-the-money strike. */
export function buildTemplate(id: TemplateId, env: TemplateEnv): LegSpec[] {
  const ks = [...new Set(env.strikes)].sort((a, b) => a - b);
  const exps = [...new Set(env.expiries)].sort((a, b) => a - b);
  if (!ks.length || !exps.length) return [];
  const q = Math.max(1e-9, Math.abs(env.qty ?? 1));
  const w = Math.max(1, Math.round(env.width ?? 1));
  const a = atmIndex(ks, env.spot);
  const k = (i: number) => ks[Math.min(ks.length - 1, Math.max(0, i))]!;
  const e0 = exps[0]!;
  const e1 = exps[1] ?? e0;
  const L = (kind: OptionKind, i: number, n: number, expiry = e0): LegSpec => ({
    kind,
    strike: k(i),
    expiry,
    qty: n * q,
  });
  switch (id) {
    case 'long-call':
      return [L('call', a, 1)];
    case 'short-call':
      return [L('call', a, -1)];
    case 'long-put':
      return [L('put', a, 1)];
    case 'short-put':
      return [L('put', a, -1)];
    case 'long-straddle':
      return [L('call', a, 1), L('put', a, 1)];
    case 'short-straddle':
      return [L('call', a, -1), L('put', a, -1)];
    case 'long-strangle':
      return [L('put', a - w, 1), L('call', a + w, 1)];
    case 'short-strangle':
      return [L('put', a - w, -1), L('call', a + w, -1)];
    case 'bull-call-spread':
      return [L('call', a, 1), L('call', a + w, -1)];
    case 'bear-call-spread':
      return [L('call', a, -1), L('call', a + w, 1)];
    case 'bull-put-spread':
      return [L('put', a, -1), L('put', a - w, 1)];
    case 'bear-put-spread':
      return [L('put', a, 1), L('put', a - w, -1)];
    case 'iron-condor':
      return [L('put', a - w, -1), L('put', a - 2 * w, 1), L('call', a + w, -1), L('call', a + 2 * w, 1)];
    case 'butterfly':
      return [L('call', a - w, 1), L('call', a, -2), L('call', a + w, 1)];
    case 'calendar':
      return [L('call', a, -1, e0), L('call', a, 1, e1)];
    case 'ratio-spread':
      return [L('call', a, 1), L('call', a + w, -2)];
  }
}
