import {
  emptyQuote,
  findContract,
  type ChainExpiry,
  type ChainStrike,
  type ChainUnderlying,
  type OptionContract,
  type OptionsChain,
  type OptionsChainSource,
  type SeriesType,
} from '../chain';
import { impliedVol } from '../iv';
import { yearFrac } from '../pricing';

/** Fetches a URL and returns the body text (window.fetch, or a Tauri command in the desktop app). */
export type FetchText = (url: string) => Promise<string>;

export const DERIBIT_API = 'https://www.deribit.com/api/v2';

export const deribitUrls = {
  instruments: (currency: string) =>
    `${DERIBIT_API}/public/get_instruments?currency=${currency}&kind=option&expired=false`,
  optionSummary: (currency: string) =>
    `${DERIBIT_API}/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
  futureSummary: (currency: string) =>
    `${DERIBIT_API}/public/get_book_summary_by_currency?currency=${currency}&kind=future`,
  ticker: (name: string) =>
    `${DERIBIT_API}/public/ticker?instrument_name=${encodeURIComponent(name)}`,
};

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Unwraps a JSON-RPC response (`{ result }`), throwing on `{ error }`. */
export function deribitResult(json: unknown): unknown {
  const o = (typeof json === 'string' ? JSON.parse(json) : json) as Json | null;
  if (!o || typeof o !== 'object') throw new Error('Deribit: malformed response');
  if (o.error) {
    const e = o.error as Json;
    throw new Error(`Deribit: ${String(e.message ?? 'error')}`);
  }
  return o.result;
}

function seriesOf(period: unknown): SeriesType {
  if (period === 'day') return 'daily';
  if (period === 'week') return 'weekly';
  return 'regular';
}

/**
 * Builds the chain model from `get_instruments` + `get_book_summary_by_currency` (options) and,
 * optionally, the futures book summary for underlying bid/ask.
 *
 * Deribit quotes options in the base currency (BTC/ETH). Prices are converted to USD with the
 * series' own `underlying_price`, which reproduces Deribit's USD mark (Black-76 on the future or
 * synthetic forward with `interest_rate`). Bid/ask IVs are solved from the quotes; sizes and
 * venue IVs arrive later through {@link applyDeribitTicker}.
 */
export function parseDeribitChain(
  currency: string,
  instrumentsJson: unknown,
  summaryJson: unknown,
  futuresJson?: unknown,
  now: number = Date.now(),
): OptionsChain {
  const instruments = (deribitResult(instrumentsJson) as Json[]) ?? [];
  const summaries = (deribitResult(summaryJson) as Json[]) ?? [];
  const futures = futuresJson ? ((deribitResult(futuresJson) as Json[]) ?? []) : [];
  const sum = new Map<string, Json>();
  for (const s of summaries) sum.set(String(s.instrument_name), s);
  const fut = new Map<string, Json>();
  for (const f of futures) fut.set(String(f.instrument_name), f);

  const byExpiry = new Map<number, { series: SeriesType; rows: Map<number, ChainStrike>; und: Json | null }>();
  let spot = 0;
  let rate = 0;
  for (const ins of instruments) {
    if (ins.kind !== 'option' || ins.is_active === false) continue;
    const name = String(ins.instrument_name);
    const expiry = num(ins.expiration_timestamp);
    const strike = num(ins.strike);
    if (expiry === null || strike === null || expiry <= now) continue;
    const kind = ins.option_type === 'put' ? 'put' : 'call';
    let e = byExpiry.get(expiry);
    if (!e) {
      e = { series: seriesOf(ins.settlement_period), rows: new Map(), und: null };
      byExpiry.set(expiry, e);
    }
    const s = sum.get(name);
    const F = num(s?.underlying_price);
    if (s && !e.und && F) e.und = s;
    if (s && num(s.estimated_delivery_price)) spot = num(s.estimated_delivery_price)!;
    if (s && num(s.interest_rate) !== null) rate = num(s.interest_rate)!;
    const quote = emptyQuote();
    if (s && F) {
      const usd = (v: unknown) => (num(v) === null ? null : num(v)! * F);
      quote.bid = usd(s.bid_price);
      quote.ask = usd(s.ask_price);
      quote.last = usd(s.last);
      quote.mark = usd(s.mark_price);
      quote.volume = num(s.volume);
      quote.openInterest = num(s.open_interest);
      quote.change = num(s.price_change);
      quote.markIv = num(s.mark_iv) === null ? null : num(s.mark_iv)! / 100;
      const T = yearFrac(now, expiry);
      const iv = (price: number | null) => {
        if (price === null || !(price > 0)) return null;
        const v = impliedVol({ kind, S: F, K: strike, T, r: num(s.interest_rate) ?? 0, model: 'b76', price });
        return Number.isFinite(v) ? v : null;
      };
      quote.bidIv = iv(quote.bid);
      quote.askIv = iv(quote.ask);
    }
    const c: OptionContract = { name, kind, strike, expiry, quote };
    const row = e.rows.get(strike) ?? { strike };
    row[kind] = c;
    e.rows.set(strike, row);
  }

  const expiries: ChainExpiry[] = [...byExpiry.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expiry, e]) => {
      const forward = num(e.und?.underlying_price) ?? spot;
      const symbol = String(e.und?.underlying_index ?? `${currency}`);
      const f = fut.get(symbol);
      return {
        expiry,
        series: e.series,
        forward,
        underlying: {
          symbol,
          bid: num(f?.bid_price),
          ask: num(f?.ask_price),
          bidSize: null,
          askSize: null,
          last: num(f?.last) ?? forward,
        },
        strikes: [...e.rows.values()].sort((a, b) => a.strike - b.strike),
      };
    });
  if (!spot) spot = expiries[0]?.forward ?? 0;
  return {
    root: currency,
    source: 'deribit',
    sourceLabel: 'Deribit',
    simulated: false,
    model: 'b76',
    r: rate,
    q: 0,
    multiplier: 1,
    spot,
    priceDecimals: spot >= 10_000 ? 0 : spot >= 100 ? 1 : 2,
    currency: 'USD',
    expiries,
    updatedAt: now,
  };
}

/**
 * Merges a `public/ticker` response into the chain: best bid/ask with sizes and venue IVs for an
 * option, or bid/ask/sizes for the underlying future of a series. Returns true when applied.
 */
export function applyDeribitTicker(chain: OptionsChain, tickerJson: unknown): boolean {
  const t = deribitResult(tickerJson) as Json | null;
  if (!t) return false;
  const name = String(t.instrument_name);
  const c = findContract(chain, name);
  if (c) {
    const F = num(t.underlying_price);
    if (!F) return false;
    const usd = (v: unknown) => (num(v) === null || num(v) === 0 ? null : num(v)! * F);
    const pct = (v: unknown) => (num(v) === null || num(v) === 0 ? null : num(v)! / 100);
    const stats = (t.stats ?? {}) as Json;
    c.quote = {
      ...c.quote,
      bid: usd(t.best_bid_price),
      ask: usd(t.best_ask_price),
      bidSize: num(t.best_bid_amount),
      askSize: num(t.best_ask_amount),
      last: usd(t.last_price) ?? c.quote.last,
      mark: usd(t.mark_price) ?? c.quote.mark,
      bidIv: pct(t.bid_iv),
      askIv: pct(t.ask_iv),
      markIv: pct(t.mark_iv) ?? c.quote.markIv,
      openInterest: num(t.open_interest) ?? c.quote.openInterest,
      volume: num(stats.volume) ?? c.quote.volume,
      change: num(stats.price_change) ?? c.quote.change,
    };
    return true;
  }
  let hit = false;
  for (const e of chain.expiries) {
    if (e.underlying.symbol !== name) continue;
    e.underlying = {
      symbol: name,
      bid: num(t.best_bid_price),
      ask: num(t.best_ask_price),
      bidSize: num(t.best_bid_amount),
      askSize: num(t.best_ask_amount),
      last: num(t.last_price) ?? e.underlying.last,
    };
    hit = true;
  }
  return hit;
}

/** Deribit public options (BTC, ETH) — free, no account needed. */
export class DeribitChainSource implements OptionsChainSource {
  readonly id = 'deribit';
  readonly label = 'Deribit';
  readonly simulated = false;
  constructor(
    private readonly fetchText: FetchText,
    private readonly clock: () => number = Date.now,
  ) {}
  underlyings(): ChainUnderlying[] {
    return [
      { id: 'BTC', label: 'BTC (Deribit)' },
      { id: 'ETH', label: 'ETH (Deribit)' },
    ];
  }
  async load(currency: string): Promise<OptionsChain> {
    const [ins, sum, fut] = await Promise.all([
      this.fetchText(deribitUrls.instruments(currency)),
      this.fetchText(deribitUrls.optionSummary(currency)),
      this.fetchText(deribitUrls.futureSummary(currency)).catch(() => null),
    ]);
    return parseDeribitChain(
      currency,
      JSON.parse(ins),
      JSON.parse(sum),
      fut ? JSON.parse(fut) : undefined,
      this.clock(),
    );
  }
  /** Fetches tickers (sizes, bid/ask IV) for the named instruments, a few at a time. */
  async enrich(chain: OptionsChain, names: readonly string[], concurrency = 4): Promise<number> {
    let done = 0;
    const queue = [...names];
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        try {
          if (applyDeribitTicker(chain, JSON.parse(await this.fetchText(deribitUrls.ticker(n))))) done++;
        } catch {
          // A missing ticker only leaves sizes blank.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return done;
  }
}
