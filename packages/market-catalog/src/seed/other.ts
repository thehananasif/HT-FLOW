import type { CatalogInstrument, ExpiryRule, SessionSpec } from '../types';
import { catalogId, EXP, future, SESSIONS, SPEC_LANDING } from './common';

/**
 * Appendix A sections 3–4: US stocks, RU market, EU stocks, indexes, HKEX futures and single-stock
 * futures. Stocks are placeholders until the NYSE / NASDAQ symbol-list file and the user's broker
 * feed are connected — all `verified: false`.
 */

const STOCK_PROVIDERS = ['ibkr', 'alpaca'];

function stock(
  ticker: string,
  name: string,
  exchange: string,
  group: string,
  subGroup: string,
  sessions: SessionSpec[],
  currency = 'USD',
  tick = 0.01,
  holidays = 'NYSE',
): CatalogInstrument {
  return {
    id: catalogId(exchange, ticker),
    symbol: ticker,
    name,
    root: ticker,
    exchange,
    assetClass: 'stock',
    group,
    subGroup,
    currency,
    tickSize: tick,
    tickValue: tick,
    pointValue: 1,
    multiplier: 1,
    unit: 'shares',
    pricePrecision: 2,
    lotStep: 1,
    minQty: 1,
    sessions,
    holidayCalendar: holidays,
    providers: (currency === 'USD' ? STOCK_PROVIDERS : ['ibkr']).map((provider) => ({
      provider,
      symbol: ticker,
    })),
    options: currency === 'USD',
    spec_source_url: SPEC_LANDING[exchange] ?? '',
    verified: false,
  };
}

/** [ticker, name, listing exchange, micro SSF listed] — the single-stock futures underlyings. */
const SSF: [string, string, 'NYSE' | 'NASDAQ', boolean][] = [
  ['ABBV', 'AbbVie', 'NYSE', false],
  ['ADBE', 'Adobe', 'NASDAQ', false],
  ['AMD', 'Advanced Micro Devices', 'NASDAQ', true],
  ['GOOGL', 'Alphabet', 'NASDAQ', true],
  ['AMZN', 'Amazon.com', 'NASDAQ', true],
  ['AMGN', 'Amgen', 'NASDAQ', false],
  ['AAPL', 'Apple', 'NASDAQ', true],
  ['AMAT', 'Applied Materials', 'NASDAQ', false],
  ['BAC', 'Bank of America', 'NYSE', true],
  ['BRK.B', 'Berkshire Hathaway', 'NYSE', false],
  ['BA', 'Boeing', 'NYSE', true],
  ['BKNG', 'Booking Holdings', 'NASDAQ', false],
  ['AVGO', 'Broadcom', 'NASDAQ', true],
  ['CAT', 'Caterpillar', 'NYSE', false],
  ['CVX', 'Chevron', 'NYSE', false],
  ['CSCO', 'Cisco Systems', 'NASDAQ', true],
  ['KO', 'Coca-Cola', 'NYSE', false],
  ['CMCSA', 'Comcast', 'NASDAQ', false],
  ['COP', 'ConocoPhillips', 'NYSE', false],
  ['COST', 'Costco Wholesale', 'NASDAQ', false],
  ['LLY', 'Eli Lilly', 'NYSE', false],
  ['XOM', 'Exxon Mobil', 'NYSE', true],
  ['HD', 'Home Depot', 'NYSE', false],
  ['INTC', 'Intel', 'NASDAQ', true],
  ['IBM', 'International Business Machines', 'NYSE', false],
  ['JNJ', 'Johnson & Johnson', 'NYSE', false],
  ['JPM', 'JPMorgan Chase', 'NYSE', true],
  ['LMT', 'Lockheed Martin', 'NYSE', false],
  ['MA', 'Mastercard', 'NYSE', false],
  ['MCD', "McDonald's", 'NYSE', false],
  ['MRK', 'Merck', 'NYSE', false],
  ['META', 'Meta Platforms', 'NASDAQ', true],
  ['MU', 'Micron Technology', 'NASDAQ', true],
  ['MSFT', 'Microsoft', 'NASDAQ', true],
  ['NFLX', 'Netflix', 'NASDAQ', true],
  ['NEM', 'Newmont', 'NYSE', true],
  ['NVDA', 'NVIDIA', 'NASDAQ', true],
  ['ORCL', 'Oracle', 'NYSE', false],
  ['PLTR', 'Palantir Technologies', 'NASDAQ', true],
  ['PANW', 'Palo Alto Networks', 'NASDAQ', false],
  ['PEP', 'PepsiCo', 'NASDAQ', false],
  ['PFE', 'Pfizer', 'NYSE', true],
  ['PG', 'Procter & Gamble', 'NYSE', false],
  ['PLD', 'Prologis', 'NYSE', false],
  ['QCOM', 'QUALCOMM', 'NASDAQ', false],
  ['CRM', 'Salesforce', 'NYSE', false],
  // Private company: no listing ticker — placeholder symbol.
  ['SPACEX', 'Space Exploration Technologies', 'NASDAQ', true],
  ['SBUX', 'Starbucks', 'NASDAQ', false],
  ['TSLA', 'Tesla', 'NASDAQ', true],
  ['TXN', 'Texas Instruments', 'NASDAQ', false],
  ['UNH', 'UnitedHealth Group', 'NYSE', false],
  ['VZ', 'Verizon Communications', 'NYSE', false],
  ['V', 'Visa', 'NYSE', false],
  ['WMT', 'Walmart', 'NYSE', true],
  ['DIS', 'Walt Disney', 'NYSE', false],
];

const US_STOCKS = SSF.filter(([t]) => t !== 'SPACEX').map(([t, name, ex]) =>
  stock(t, name, ex, 'US Stocks & Other', `US Stocks · ${ex}`, SESSIONS.usStocks),
);

// TODO(verify): MOEX / EU tickers, ticks and lot sizes come from the user's broker connector.
const RU = (sub: string, list: [string, string][], tick = 0.01) =>
  list.map(([t, n]) =>
    stock(
      t,
      n,
      'MOEX',
      'US Stocks & Other',
      `RU Market · ${sub}`,
      SESSIONS.moex,
      'RUB',
      tick,
      'MOEX',
    ),
  );
const RU_MARKET = [
  ...RU(
    'Currencies',
    [
      ['USDRUB_TOM', 'US Dollar / Russian Ruble (TOM)'],
      ['EURRUB_TOM', 'Euro / Russian Ruble (TOM)'],
      ['CNYRUB_TOM', 'Chinese Yuan / Russian Ruble (TOM)'],
    ],
    0.0025,
  ),
  ...RU(
    'Futures',
    [
      ['Si', 'USD/RUB futures'],
      ['RI', 'RTS Index futures'],
      ['BR', 'Brent futures (MOEX)'],
      ['GD', 'Gold futures (MOEX)'],
    ],
    1,
  ),
  ...RU('Stocks', [
    ['SBER', 'Sberbank'],
    ['GAZP', 'Gazprom'],
    ['LKOH', 'Lukoil'],
    ['ROSN', 'Rosneft'],
    ['GMKN', 'Norilsk Nickel'],
  ]),
  ...RU(
    'Funds',
    [
      ['TMOS', 'MOEX Russia index fund'],
      ['SBMX', 'Sber MOEX index fund'],
    ],
    0.001,
  ),
].map((i) =>
  i.subGroup.endsWith('Futures')
    ? { ...i, assetClass: 'future' as const }
    : i.subGroup.endsWith('Currencies')
      ? { ...i, assetClass: 'currency' as const }
      : i.subGroup.endsWith('Funds')
        ? { ...i, assetClass: 'fund' as const }
        : i,
);

const EU_STOCKS: CatalogInstrument[] = (
  [
    ['SAP', 'SAP', 'XETRA'],
    ['SIE', 'Siemens', 'XETRA'],
    ['ASML', 'ASML Holding', 'Euronext'],
    ['MC', 'LVMH', 'Euronext'],
    ['TTE', 'TotalEnergies', 'Euronext'],
    ['NESN', 'Nestlé', 'SIX'],
  ] as const
).map(([t, n, ex]) =>
  stock(
    t,
    n,
    ex,
    'US Stocks & Other',
    'EU Stocks',
    SESSIONS.euStocks,
    ex === 'SIX' ? 'CHF' : 'EUR',
    0.01,
    'NONE',
  ),
);

const INDEXES = [
  future({
    name: 'CBOE Volatility Index',
    root: 'VX',
    exchange: 'CFE',
    sub: 'Indexes',
    group: 'US Stocks & Other',
    tick: 0.05,
    tickValue: 50,
    mult: 1000,
    unit: 'USD per point',
    cycle: 'FGHJKMNQUVXZ',
    expiry: EXP.vix,
    roll: 5,
    listed: 8,
    sessions: SESSIONS.cfe,
    holidays: 'CFE',
    verified: true,
    options: false,
    aliases: ['VIX'],
  }),
  future({
    name: 'Mini CBOE Volatility Index',
    root: 'VXM',
    exchange: 'CFE',
    sub: 'Indexes',
    group: 'US Stocks & Other',
    tick: 0.05,
    tickValue: 5,
    mult: 100,
    unit: 'USD per point',
    cycle: 'FGHJKMNQUVXZ',
    expiry: EXP.vix,
    roll: 5,
    listed: 6,
    sessions: SESSIONS.cfe,
    holidays: 'CFE',
    verified: true,
    aliases: ['Mini VIX'],
  }),
];

const hk = (
  name: string,
  root: string,
  tick: number,
  tv: number,
  mult: number,
  verified: boolean,
  currency = 'HKD',
  expiry: ExpiryRule = EXP.hkex,
) =>
  future({
    name,
    root,
    exchange: 'HKEX',
    sub: 'HKEX Futures',
    group: 'US Stocks & Other',
    tick,
    tickValue: tv,
    mult,
    unit: `${currency} per point`,
    currency,
    cycle: 'FGHJKMNQUVXZ',
    expiry,
    roll: 2,
    listed: 4,
    sessions: SESSIONS.hkex,
    holidays: 'HKEX',
    verified,
  });
const HKEX = [
  hk('Hang Seng China Enterprises', 'HHI', 1, 50, 50, true),
  hk('Hang Seng Index', 'HSI', 1, 50, 50, true),
  // TODO(verify): Hang Seng TECH and MSCI contract sizes / ticks.
  hk('Hang Seng TECH', 'HTI', 1, 50, 50, false),
  hk('Mini-Hang Seng China Enterprises', 'MCH', 1, 10, 10, true),
  hk('Mini-Hang Seng Index', 'MHI', 1, 10, 10, true),
  hk('MSCI China A 50 Connect', 'MCA', 0.5, 25, 50, false, 'USD'),
  hk('MSCI Taiwan Index', 'MTW', 0.1, 10, 100, false, 'USD'),
  hk('USD/CNH', 'CUS', 0.0001, 10, 100000, true, 'CNH', EXP.fx),
];

// TODO(verify): single-stock futures venue, symbols, contract size (100 / 10 shares assumed) and
// last trading day are not known to the author — every SSF row is a placeholder.
const SINGLE_STOCK = SSF.flatMap(([t, name, , micro]) => {
  const mk = (sym: string, n: string, sub: string, mult: number) => {
    const f = future({
      name: n,
      root: sym,
      exchange: 'SSF',
      sub,
      group: 'Single Stock Futures',
      tick: 0.01,
      tickValue: 0.01 * mult,
      mult,
      unit: 'shares',
      cycle: 'HMUZ',
      expiry: EXP.thirdFriday,
      roll: 5,
      listed: 4,
      sessions: SESSIONS.usStocks,
      holidays: 'NYSE',
      verified: false,
      aliases: [t, name],
    });
    return { ...f, providers: [{ provider: 'ibkr', symbol: sym }] };
  };
  const out = [mk(`${t}1!`, name, 'Standard', 100)];
  if (micro) out.push(mk(`M${t}1!`, `${name} (Micro)`, 'Micro', 10));
  return out;
});

export const OTHER: CatalogInstrument[] = [
  ...US_STOCKS,
  ...RU_MARKET,
  ...EU_STOCKS,
  ...INDEXES,
  ...HKEX,
  ...SINGLE_STOCK,
];

/** Appendix A section 5: dxFeed exchange groups (user's own dxFeed license, "Delayed 15m"). */
export const DXFEED_GROUPS: { name: string; exchanges: string[]; roots?: string[] }[] = [
  { name: 'CBOT', exchanges: ['CBOT'] },
  { name: 'CME', exchanges: ['CME'] },
  { name: 'COMEX', exchanges: ['COMEX'] },
  { name: 'EUREX', exchanges: ['EUREX'] },
  { name: 'IFUS (ICE US)', exchanges: ['ICE US'] },
  { name: 'NYBOT', exchanges: ['ICE US'], roots: ['CC', 'KC', 'CT', 'OJ', 'DX'] },
  { name: 'NYMEX', exchanges: ['NYMEX'] },
];
