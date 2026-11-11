import type {
  CatalogAssetClass,
  CatalogInstrument,
  ContractSpec,
  ExpiryRule,
  ProviderMapping,
  SessionSpec,
} from '../types';

export const TZ = {
  CT: 'America/Chicago',
  ET: 'America/New_York',
  CET: 'Europe/Berlin',
  HKT: 'Asia/Hong_Kong',
  MSK: 'Europe/Moscow',
  UTC: 'UTC',
} as const;

const WEEK = [1, 2, 3, 4, 5];
/** Globex-style sessions open Sunday–Thursday evening and run into the next day. */
const EVENINGS = [0, 1, 2, 3, 4];
const ALL = [0, 1, 2, 3, 4, 5, 6];

const rth = (tz: string, open: string, close: string, extra: Partial<SessionSpec> = {}) =>
  ({ name: 'RTH', tz, open, close, days: WEEK, ...extra }) as SessionSpec;
const eth = (tz: string, open: string, close: string, extra: Partial<SessionSpec> = {}) =>
  ({ name: 'ETH', tz, open, close, days: EVENINGS, ...extra }) as SessionSpec;
const globex = eth(TZ.CT, '17:00', '16:00');

/** Exchange-standard session templates (holiday calendars and early closes not applied). */
export const SESSIONS = {
  cmeEquity: [rth(TZ.CT, '08:30', '15:00'), globex],
  cmeEnergy: [rth(TZ.CT, '08:00', '13:30'), globex],
  cmeMetals: [rth(TZ.CT, '07:20', '12:30'), globex],
  cmeRates: [rth(TZ.CT, '07:20', '14:00'), globex],
  cmeFx: [rth(TZ.CT, '07:20', '14:00'), globex],
  cmeCrypto: [rth(TZ.CT, '08:30', '15:00'), globex],
  cbotGrains: [
    rth(TZ.CT, '08:30', '13:20'),
    eth(TZ.CT, '19:00', '13:20', { breaks: [{ from: '07:45', to: '08:30' }] }),
  ],
  cmeLivestock: [rth(TZ.CT, '08:30', '13:05'), eth(TZ.CT, '08:30', '13:05', { days: WEEK })],
  // TODO(verify): CME dairy hours.
  cmeDairy: [rth(TZ.CT, '08:30', '13:55'), eth(TZ.CT, '08:30', '13:55', { days: WEEK })],
  iceCocoa: [rth(TZ.ET, '04:45', '13:30'), eth(TZ.ET, '04:45', '13:30', { days: WEEK })],
  iceCoffee: [rth(TZ.ET, '04:15', '13:30'), eth(TZ.ET, '04:15', '13:30', { days: WEEK })],
  // TODO(verify): ICE cotton RTH split.
  iceCotton: [rth(TZ.ET, '09:30', '14:20'), eth(TZ.ET, '21:00', '14:20')],
  iceOj: [rth(TZ.ET, '08:00', '14:00'), eth(TZ.ET, '08:00', '14:00', { days: WEEK })],
  // TODO(verify): ICE US Dollar Index RTH.
  iceDx: [rth(TZ.ET, '08:20', '15:00'), eth(TZ.ET, '20:00', '17:00')],
  eurexEquity: [rth(TZ.CET, '09:00', '17:30'), eth(TZ.CET, '01:10', '22:00', { days: WEEK })],
  eurexRates: [rth(TZ.CET, '08:00', '17:15'), eth(TZ.CET, '01:10', '22:00', { days: WEEK })],
  // TODO(verify): VSTOXX futures hours.
  eurexVol: [rth(TZ.CET, '09:00', '17:30'), eth(TZ.CET, '08:00', '22:00', { days: WEEK })],
  cfe: [rth(TZ.CT, '08:30', '15:00'), eth(TZ.CT, '17:00', '16:00')],
  hkex: [
    rth(TZ.HKT, '09:15', '16:30', { breaks: [{ from: '12:00', to: '13:00' }] }),
    eth(TZ.HKT, '17:15', '03:00', { days: WEEK }),
  ],
  crypto: [{ name: 'ETH', tz: TZ.UTC, open: '00:00', close: '00:00', days: ALL }] as SessionSpec[],
  usStocks: [rth(TZ.ET, '09:30', '16:00'), eth(TZ.ET, '04:00', '20:00', { days: WEEK })],
  // TODO(verify): MOEX main / evening sessions per market.
  moex: [rth(TZ.MSK, '10:00', '18:50'), eth(TZ.MSK, '07:00', '23:50', { days: WEEK })],
  euStocks: [rth(TZ.CET, '09:00', '17:30'), eth(TZ.CET, '08:00', '22:00', { days: WEEK })],
} satisfies Record<string, SessionSpec[]>;

export function decimals(x: number): number {
  const s = String(x);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1]!.length : 0;
}

export const catalogId = (exchange: string, symbol: string) =>
  `cat:${exchange.toUpperCase().replace(/\s+/g, '-')}:${symbol}`;

/** Futures brokers / data feeds that can serve each exchange (user's own account). */
const FUTURES_PROVIDERS: Record<string, string[]> = {
  CME: ['rithmic', 'cqg', 'dxfeed', 'ibkr', 'tradovate'],
  CBOT: ['rithmic', 'cqg', 'dxfeed', 'ibkr', 'tradovate'],
  NYMEX: ['rithmic', 'cqg', 'dxfeed', 'ibkr', 'tradovate'],
  COMEX: ['rithmic', 'cqg', 'dxfeed', 'ibkr', 'tradovate'],
  EUREX: ['rithmic', 'cqg', 'dxfeed', 'ibkr'],
  'ICE US': ['rithmic', 'cqg', 'dxfeed', 'ibkr'],
  CFE: ['cqg', 'ibkr'],
  HKEX: ['cqg', 'ibkr'],
};

/** Provider-specific futures roots where they differ from the exchange root. */
const IBKR_ROOTS: Record<string, string> = {
  '6E': 'EUR',
  '6J': 'JPY',
  '6B': 'GBP',
  '6A': 'AUD',
  '6C': 'CAD',
  '6S': 'CHF',
  '6N': 'NZD',
  '6M': 'MXP',
};

export function futuresProviders(root: string, exchange: string, sim?: string): ProviderMapping[] {
  const out: ProviderMapping[] = (FUTURES_PROVIDERS[exchange] ?? []).map((provider) => ({
    provider,
    symbol:
      provider === 'dxfeed' ? `/${root}` : provider === 'ibkr' ? (IBKR_ROOTS[root] ?? root) : root,
  }));
  if (sim) out.unshift({ provider: 'sim', symbol: sim });
  return out;
}

export const SPEC_LANDING: Record<string, string> = {
  CME: 'https://www.cmegroup.com/markets/products.html',
  CBOT: 'https://www.cmegroup.com/markets/products.html',
  NYMEX: 'https://www.cmegroup.com/markets/products.html',
  COMEX: 'https://www.cmegroup.com/markets/products.html',
  EUREX: 'https://www.eurex.com/ex-en/markets',
  'ICE US': 'https://www.ice.com/futures-us',
  CFE: 'https://www.cboe.com/tradable_products/futures/',
  HKEX: 'https://www.hkex.com.hk/Products/Listed-Derivatives',
  NYSE: 'https://www.nyse.com/listings_directory/stock',
  NASDAQ: 'https://www.nasdaq.com/market-activity/stocks/screener',
  MOEX: 'https://www.moex.com/en/',
  // TODO(verify): the single-stock futures venue is not known; points at a broker product list.
  SSF: 'https://www.interactivebrokers.com/en/trading/products-exchanges.php',
  XETRA: 'https://www.xetra.com/xetra-en/',
  Euronext: 'https://live.euronext.com/en',
  SIX: 'https://www.six-group.com/en/market-data/shares.html',
};

export const cmeUrl = (path: string) =>
  `https://www.cmegroup.com/markets/${path}.contractSpecs.html`;

export interface FutureDef {
  name: string;
  root: string;
  exchange: string;
  sub: string;
  tick: number;
  tickValue: number;
  /** Contract size in `unit`. */
  mult: number;
  unit: string;
  currency?: string;
  cycle: string;
  expiry: ExpiryRule;
  /** Calendar days before expiry the continuous contract rolls. */
  roll: number;
  listed?: number;
  sessions: SessionSpec[];
  holidays?: string;
  options?: boolean;
  url?: string;
  verified: boolean;
  /** Built-in MockFeed instrument serving this root (Sim). */
  sim?: string;
  aliases?: string[];
  note?: string;
  group?: string;
  assetClass?: CatalogAssetClass;
}

export function future(d: FutureDef): CatalogInstrument {
  const contract: ContractSpec = {
    cycle: d.cycle,
    expiry: d.expiry,
    roll: { kind: 'date', daysBefore: d.roll },
    backAdjust: false,
    listed: d.listed ?? Math.min(12, d.cycle.length * 2),
  };
  return {
    id: catalogId(d.exchange, d.root),
    symbol: d.root,
    name: d.name,
    root: d.root,
    exchange: d.exchange,
    assetClass: d.assetClass ?? 'future',
    group: d.group ?? 'US and EU Futures',
    subGroup: d.sub,
    currency: d.currency ?? 'USD',
    tickSize: d.tick,
    tickValue: d.tickValue,
    pointValue: +(d.tickValue / d.tick).toPrecision(12),
    multiplier: d.mult,
    unit: d.unit,
    pricePrecision: decimals(d.tick),
    lotStep: 1,
    minQty: 1,
    sessions: d.sessions,
    holidayCalendar: d.holidays ?? 'CME',
    contract,
    providers: futuresProviders(d.root, d.exchange, d.sim),
    options: d.options ?? false,
    spec_source_url: d.url ?? SPEC_LANDING[d.exchange] ?? '',
    verified: d.verified,
    aliases: d.aliases,
    note: d.note,
  };
}

/** Common expiry rules. */
export const EXP = {
  thirdFriday: { kind: 'nthWeekday', n: 3, weekday: 5 },
  /** CME FX: second business day before the third Wednesday. */
  fx: { kind: 'nthWeekday', n: 3, weekday: 3, bdBefore: 2 },
  lastFriday: { kind: 'lastWeekday', weekday: 5 },
  /** CBOT grains: business day prior to the 15th calendar day. */
  grains: { kind: 'dayOfMonth', day: 15, bdBefore: 1 },
  /** COMEX metals: third last business day of the contract month. */
  metals: { kind: 'lastBusinessDay', bdBefore: 2 },
  lastBusinessDay: { kind: 'lastBusinessDay' },
  /** ZN / ZB / TN / UB: seventh business day preceding the last business day. */
  longTreasury: { kind: 'lastBusinessDay', bdBefore: 7 },
  /** CL: 3 business days before the 25th of the prior month (25th moved to a business day first). */
  crude: { kind: 'dayOfMonth', day: 25, monthOffset: -1, bdBefore: 3, adjustFirst: true },
  /** QM / MCL: one business day before CL. */
  crudeMini: { kind: 'dayOfMonth', day: 25, monthOffset: -1, bdBefore: 4, adjustFirst: true },
  /** NG: 3 business days before the first calendar day of the contract month. */
  natgas: { kind: 'dayOfMonth', day: 1, bdBefore: 3 },
  natgasMini: { kind: 'dayOfMonth', day: 1, bdBefore: 4 },
  /** HO / RB: last business day of the month before the contract month. */
  products: { kind: 'lastBusinessDay', monthOffset: -1 },
  /** EUREX fixed income: two exchange days before the 10th calendar day. */
  eurexBond: { kind: 'dayOfMonth', day: 10, bdBefore: 2 },
  vix: { kind: 'vix' },
  /** HKEX index futures: business day before the last business day. */
  hkex: { kind: 'lastBusinessDay', bdBefore: 1 },
} satisfies Record<string, ExpiryRule>;
