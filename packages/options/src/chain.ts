import { DAY_MS, type OptionKind, type PricingModel } from './pricing';

/** Expiry cycle of a series. Deribit daily expiries are reported as `daily`. */
export type SeriesType = 'regular' | 'weekly' | 'eom' | 'daily';

export interface OptionQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  /** 24 h change of the option price, percent. */
  change: number | null;
  /** Implied volatilities, decimal. */
  bidIv: number | null;
  askIv: number | null;
  markIv: number | null;
  /** Venue / model mark price. */
  mark: number | null;
}

export interface OptionContract {
  /** Contract name, e.g. BTC-27NOV26-70000-C. */
  name: string;
  kind: OptionKind;
  strike: number;
  expiry: number;
  quote: OptionQuote;
}

export interface ChainStrike {
  strike: number;
  call?: OptionContract;
  put?: OptionContract;
}

export interface UnderlyingQuote {
  /** Underlying contract of the series, e.g. BTC-27NOV26 or ESZ6. */
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
}

export interface ChainExpiry {
  expiry: number;
  series: SeriesType;
  underlying: UnderlyingQuote;
  /** Price the options of this expiry are priced off (futures / forward for b76, spot for bs). */
  forward: number;
  /** Ascending by strike. */
  strikes: ChainStrike[];
}

export interface OptionsChain {
  /** Root, e.g. BTC or ES. */
  root: string;
  source: 'sim' | 'deribit';
  /** Badge text: "Sim" for simulated chains, venue name otherwise. */
  sourceLabel: string;
  simulated: boolean;
  model: PricingModel;
  r: number;
  q: number;
  /** Currency value of one point per contract. */
  multiplier: number;
  /** Reference / index price of the underlying. */
  spot: number;
  /** Decimals for option prices on the board. */
  priceDecimals: number;
  currency: string;
  expiries: ChainExpiry[];
  updatedAt: number;
}

export interface ChainUnderlying {
  /** Id passed to `load`, e.g. BTC or mock:ESZ6. */
  id: string;
  label: string;
}

/** A source of option chains (simulator, Deribit, later CME through a user feed). */
export interface OptionsChainSource {
  readonly id: string;
  readonly label: string;
  /** Simulated data must always be labelled as such in the UI. */
  readonly simulated: boolean;
  underlyings(): ChainUnderlying[];
  load(underlying: string, opts?: ChainLoadOptions): Promise<OptionsChain>;
}

export interface ChainLoadOptions {
  /** Risk-free rate used by model-priced (simulated) chains, decimal. */
  r?: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Deribit-style expiry code, e.g. 27NOV26 (UTC). */
export function expiryCode(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

/** Board label, e.g. "27 Nov 26" (UTC). */
export function expiryLabel(ms: number): string {
  const d = new Date(ms);
  const m = MONTHS[d.getUTCMonth()]!;
  return `${d.getUTCDate()} ${m[0]}${m.slice(1).toLowerCase()} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

/** Long label, e.g. "27 Nov 2026" (UTC). */
export function expiryLongLabel(ms: number): string {
  const d = new Date(ms);
  const m = MONTHS[d.getUTCMonth()]!;
  return `${d.getUTCDate()} ${m[0]}${m.slice(1).toLowerCase()} ${d.getUTCFullYear()}`;
}

/** Contract name in Deribit format: ROOT-27NOV26-70000-C. */
export function contractName(root: string, expiry: number, strike: number, kind: OptionKind): string {
  const k = Number.isInteger(strike) ? String(strike) : String(+strike.toFixed(8)).replace('.', 'd');
  return `${root}-${expiryCode(expiry)}-${k}-${kind === 'call' ? 'C' : 'P'}`;
}

/** Whole days until expiry (ceil, never negative). */
export function daysToExpiry(expiry: number, now: number): number {
  return Math.max(0, Math.ceil((expiry - now) / DAY_MS));
}

export function midPrice(q: OptionQuote): number | null {
  if (q.bid !== null && q.ask !== null && q.bid > 0) return (q.bid + q.ask) / 2;
  return q.mark ?? q.ask ?? q.bid ?? q.last;
}

/** The strike nearest to `price`. */
export function nearestStrike(strikes: readonly ChainStrike[], price: number): ChainStrike | undefined {
  let best: ChainStrike | undefined;
  for (const s of strikes)
    if (!best || Math.abs(s.strike - price) < Math.abs(best.strike - price)) best = s;
  return best;
}

/**
 * Rows to show around the money: `n` strikes at or above the ATM strike and n − 1 below it
 * (2n − 1 rows), ascending.
 */
export function strikesAround(strikes: readonly ChainStrike[], price: number, n: number): ChainStrike[] {
  const atm = nearestStrike(strikes, price);
  if (!atm) return [];
  const i = strikes.indexOf(atm);
  const lo = Math.max(0, i - (n - 1));
  const hi = Math.min(strikes.length, i + n);
  return strikes.slice(lo, hi);
}

export function findContract(chain: OptionsChain, name: string): OptionContract | undefined {
  for (const e of chain.expiries)
    for (const s of e.strikes) {
      if (s.call?.name === name) return s.call;
      if (s.put?.name === name) return s.put;
    }
  return undefined;
}

export function emptyQuote(): OptionQuote {
  return {
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    last: null,
    volume: null,
    openInterest: null,
    change: null,
    bidIv: null,
    askIv: null,
    markIv: null,
    mark: null,
  };
}
