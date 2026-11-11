/**
 * Instrument model of the market catalog (P04). Pure data: no UI, no network.
 *
 * Prices in the catalog are plain decimals (contract-spec units). The live engine converts to
 * integer ticks with `tickSize` once data arrives (see @htflow/market-data).
 */

export type CatalogAssetClass = 'future' | 'crypto' | 'stock' | 'index' | 'currency' | 'fund';

/** A trading session in exchange-local time. */
export interface SessionSpec {
  /**
   * RTH = regular (day / pit) hours. ETH = the electronic / extended session (on most venues it
   * spans RTH; on HKEX it is the separate night session).
   */
  name: 'RTH' | 'ETH';
  /** IANA time zone the times are written in (the exchange's own zone). */
  tz: string;
  /** "HH:MM" local open. */
  open: string;
  /** "HH:MM" local close; a close at or before the open means the session ends the next day. */
  close: string;
  /** Week days (0 = Sunday … 6 = Saturday) on which the session OPENS. */
  days: number[];
  /** Daily pauses inside the session (e.g. HKEX lunch, CBOT grain halt), local time, same day. */
  breaks?: { from: string; to: string }[];
}

/**
 * When a contract month stops trading. Dates are calendar dates (UTC); business days are
 * Monday–Friday. Exchange holiday calendars are not applied yet (see `holidayCalendar`).
 */
export type ExpiryRule =
  /** No expiry (perpetual swap, spot, stock). */
  | { kind: 'none' }
  /** N-th given weekday of the month (+monthOffset), then `bdBefore` business days earlier. */
  | { kind: 'nthWeekday'; n: number; weekday: number; monthOffset?: number; bdBefore?: number }
  /** Last given weekday of the month (+monthOffset). */
  | { kind: 'lastWeekday'; weekday: number; monthOffset?: number }
  /**
   * `bdBefore` business days before a calendar day of the month (+monthOffset). With
   * `adjustFirst` a non-business day is first moved back to the preceding business day (CL rule).
   * With bdBefore 0 the day itself, or the preceding business day.
   */
  | {
      kind: 'dayOfMonth';
      day: number;
      monthOffset?: number;
      bdBefore?: number;
      adjustFirst?: boolean;
    }
  /** Last business day of the month (+monthOffset), then `bdBefore` business days earlier. */
  | { kind: 'lastBusinessDay'; monthOffset?: number; bdBefore?: number }
  /** N-th business day of the month (+monthOffset). */
  | { kind: 'nthBusinessDay'; n: number; monthOffset?: number }
  /** CBOE VIX style: the Wednesday 30 days before the 3rd Friday of the following month. */
  | { kind: 'vix' };

export interface ContractSpec {
  /** Listed month codes in order (F G H J K M N Q U V X Z), e.g. "HMUZ" quarterly, all 12 monthly. */
  cycle: string;
  expiry: ExpiryRule;
  /**
   * Front-month auto-roll for continuous contracts. `date` rolls `daysBefore` calendar days before
   * expiry. `volume` rolls when the next contract trades more volume; it needs data, so until a
   * provider supplies volume the date fallback is used.
   */
  roll: { kind: 'date'; daysBefore: number } | { kind: 'volume'; fallbackDaysBefore: number };
  /** Continuous contract back-adjusted for roll gaps (default false = raw splice). */
  backAdjust: boolean;
  /** How many contract months to show on a forward curve. */
  listed: number;
}

/** A data provider that can serve the instrument, with its provider-specific symbol. */
export interface ProviderMapping {
  /**
   * Provider key. Feed ids are `${provider}:${symbol}` (e.g. `binance-futures:BTCUSDT`,
   * `bybit-linear:BTCUSDT`). `sim` maps to a built-in MockFeed id given in full (`mock:CLZ6`).
   */
  provider: string;
  symbol: string;
}

export interface CatalogInstrument {
  /** Stable catalog id: `cat:<EXCHANGE>:<SYMBOL>`. */
  id: string;
  /** Display symbol (the root for futures, the venue symbol for crypto, the ticker for stocks). */
  symbol: string;
  /** Display name exactly as in Appendix A where given. */
  name: string;
  /** Root symbol (futures) / base asset (crypto) / ticker (stocks). */
  root: string;
  exchange: string;
  assetClass: CatalogAssetClass;
  /** Appendix A group, e.g. "US and EU Futures". */
  group: string;
  /** Appendix A sub-group, e.g. "Energy". */
  subGroup: string;
  /** Quote currency. */
  currency: string;
  /** Minimum price increment in quote units. */
  tickSize: number;
  /** Currency value of one tick for one contract. */
  tickValue: number;
  /** Currency value of a 1.0 move in price for one contract (tickValue / tickSize). */
  pointValue: number;
  /** Contract size in underlying units (barrels, troy oz, index multiplier, coins …). */
  multiplier: number;
  /** Unit of `multiplier`, e.g. "bbl". */
  unit?: string;
  pricePrecision: number;
  /** Quantity increment. */
  lotStep: number;
  minQty: number;
  sessions: SessionSpec[];
  /** Holiday calendar id (CME, ICE_US, EUREX, HKEX, CFE, NYSE, MOEX, NONE). Dates: TODO. */
  holidayCalendar: string;
  /** Expiry and roll rules (dated futures only). */
  contract?: ContractSpec;
  providers: ProviderMapping[];
  /** Options listed on this underlying. */
  options: boolean;
  /** Official contract-spec page the values must be verified against before release. */
  spec_source_url: string;
  /**
   * true = tick size / tick value / point value are the standard published contract values.
   * false = placeholder or uncertain values that MUST be checked against `spec_source_url`.
   * Sessions are exchange-standard hours without holiday calendars in either case.
   */
  verified: boolean;
  /** Extra search words (old names, common nicknames, base/quote assets). */
  aliases?: string[];
  note?: string;
}

/** A node of the picker tree: group → sub-group → instrument ids. */
export interface CatalogGroup {
  name: string;
  subGroups: { name: string; ids: string[] }[];
}
