import type { CatalogInstrument, ExpiryRule, SessionSpec } from '../types';
import { cmeUrl, EXP, future, SESSIONS } from './common';

/**
 * Appendix A section 1 — US and EU futures.
 *
 * `verified: true` rows carry the standard published tick size / tick value / contract size.
 * `verified: false` rows are placeholders or values the author is not certain of — each has a
 * TODO(verify). Every row must still be checked against `spec_source_url` before release
 * (Appendix A rule); expiry rules ignore exchange holidays.
 */
type Row = [
  name: string,
  root: string,
  exchange: string,
  tick: number,
  tickValue: number,
  mult: number,
  unit: string,
  cycle: string,
  expiry: ExpiryRule,
  verified: boolean,
  extra?: {
    url?: string;
    sim?: string;
    currency?: string;
    roll?: number;
    listed?: number;
    options?: boolean;
    aliases?: string[];
    note?: string;
    sessions?: SessionSpec[];
    holidays?: string;
  },
];

const M = 'FGHJKMNQUVXZ';
const Q = 'HMUZ';
const GRAIN = 'HKNUZ';

function rows(sub: string, sessions: SessionSpec[], roll: number, list: Row[]): CatalogInstrument[] {
  return list.map(([name, root, exchange, tick, tickValue, mult, unit, cycle, expiry, verified, x]) =>
    future({
      name,
      root,
      exchange,
      sub,
      tick,
      tickValue,
      mult,
      unit,
      cycle,
      expiry,
      verified,
      sessions: x?.sessions ?? sessions,
      roll: x?.roll ?? roll,
      listed: x?.listed,
      url: x?.url,
      sim: x?.sim,
      currency: x?.currency,
      options: x?.options ?? verified,
      aliases: x?.aliases,
      note: x?.note,
      holidays:
        x?.holidays ?? (exchange === 'EUREX' ? 'EUREX' : exchange === 'ICE US' ? 'ICE_US' : 'CME'),
    }),
  );
}

const softsExpiry = (bd: number): ExpiryRule => ({ kind: 'lastBusinessDay', bdBefore: bd });

const AGRICULTURAL = rows('Agricultural', SESSIONS.cbotGrains, 14, [
  ['Corn', 'ZC', 'CBOT', 0.25, 12.5, 5000, 'bu', GRAIN, EXP.grains, true, { url: cmeUrl('agriculture/grains/corn') }],
  ['Oats', 'ZO', 'CBOT', 0.25, 12.5, 5000, 'bu', GRAIN, EXP.grains, true, { url: cmeUrl('agriculture/grains/oats') }],
  // TODO(verify): rough rice tick ($0.005/cwt = $10) and listed months.
  ['Rough Rice', 'ZR', 'CBOT', 0.005, 10, 2000, 'cwt', 'FHKNUX', EXP.grains, false, { url: cmeUrl('agriculture/grains/rough-rice') }],
  ['Soybean Meal', 'ZM', 'CBOT', 0.1, 10, 100, 'short tons', 'FHKNQUVZ', EXP.grains, true, { url: cmeUrl('agriculture/oilseeds/soybean-meal') }],
  ['Soybean Oil', 'ZL', 'CBOT', 0.01, 6, 60000, 'lb', 'FHKNQUVZ', EXP.grains, true, { url: cmeUrl('agriculture/oilseeds/soybean-oil') }],
  ['Soybeans', 'ZS', 'CBOT', 0.25, 12.5, 5000, 'bu', 'FHKNQUX', EXP.grains, true, { url: cmeUrl('agriculture/oilseeds/soybean') }],
  ['Wheat', 'ZW', 'CBOT', 0.25, 12.5, 5000, 'bu', GRAIN, EXP.grains, true, { url: cmeUrl('agriculture/grains/wheat'), aliases: ['Chicago SRW Wheat'] }],
  // TODO(verify): Class III milk last trading day (tied to the USDA price announcement) and hours.
  ['Class III Milk', 'DC', 'CME', 0.01, 20, 200000, 'lb', M, EXP.lastBusinessDay, false, { sessions: SESSIONS.cmeDairy, url: cmeUrl('agriculture/dairy/class-iii-milk') }],
  // TODO(verify): ICE softs last trading days (notice-day based) — approximated in business days.
  ['Cocoa', 'CC', 'ICE US', 1, 10, 10, 't', GRAIN, softsExpiry(11), false, { sessions: SESSIONS.iceCocoa }],
  ['Coffee', 'KC', 'ICE US', 0.05, 18.75, 37500, 'lb', GRAIN, softsExpiry(8), false, { sessions: SESSIONS.iceCoffee, aliases: ['Coffee C', 'Arabica'] }],
  ['Cotton', 'CT', 'ICE US', 0.01, 5, 50000, 'lb', 'HKNVZ', softsExpiry(16), false, { sessions: SESSIONS.iceCotton, aliases: ['Cotton No. 2'] }],
  ['Lean Hogs', 'HE', 'CME', 0.025, 10, 40000, 'lb', 'GJKMNQVZ', { kind: 'nthBusinessDay', n: 10 }, true, { sessions: SESSIONS.cmeLivestock, url: cmeUrl('agriculture/livestock/lean-hogs') }],
  ['Live Cattle', 'LE', 'CME', 0.025, 10, 40000, 'lb', 'GJMQVZ', EXP.lastBusinessDay, true, { sessions: SESSIONS.cmeLivestock, url: cmeUrl('agriculture/livestock/live-cattle') }],
  // TODO(verify): mini grain tick (1/8 cent = $1.25).
  ['Mini-Corn', 'XC', 'CBOT', 0.125, 1.25, 1000, 'bu', GRAIN, EXP.grains, false],
  ['Mini-sized Chicago SRW Wheat', 'XW', 'CBOT', 0.125, 1.25, 1000, 'bu', GRAIN, EXP.grains, false],
  ['Orange Juice', 'OJ', 'ICE US', 0.05, 7.5, 15000, 'lb', 'FHKNUX', softsExpiry(14), false, { sessions: SESSIONS.iceOj, aliases: ['FCOJ-A'] }],
]);

const T = (p: string) => cmeUrl(`interest-rates/us-treasury/${p}`);
const yieldNote = 'Micro Treasury Yield: quoted in yield, 1 bp = $10.';
const INTEREST_RATES = [
  ...rows('Interest Rates', SESSIONS.cmeRates, 21, [
    ['10-Year T-Note', 'ZN', 'CBOT', 0.015625, 15.625, 100000, 'USD face', Q, EXP.longTreasury, true, { url: T('10-year-us-treasury-note'), note: 'Quoted in points and halves of 1/32.' }],
    ['2-Year T-Note', 'ZT', 'CBOT', 0.00390625, 7.8125, 200000, 'USD face', Q, EXP.lastBusinessDay, true, { url: T('2-year-us-treasury-note'), note: 'Quoted in points and eighths of 1/32.' }],
    ['30-Day Fed Funds', 'ZQ', 'CBOT', 0.005, 20.835, 4167, 'USD per point', M, EXP.lastBusinessDay, true, { url: cmeUrl('interest-rates/stirs/30-day-federal-fund'), roll: 3, note: 'Nearest expiring month ticks in 0.0025 ($10.4175).' }],
    ['30-Year T-Bond', 'ZB', 'CBOT', 0.03125, 31.25, 100000, 'USD face', Q, EXP.longTreasury, true, { url: T('30-year-us-treasury-bond'), note: 'Quoted in points and 1/32.' }],
    ['5-Year T-Note', 'ZF', 'CBOT', 0.0078125, 7.8125, 100000, 'USD face', Q, EXP.lastBusinessDay, true, { url: T('5-year-us-treasury-note'), note: 'Quoted in points and quarters of 1/32.' }],
    ['1-Month SOFR', 'SR1', 'CME', 0.005, 12.5, 2500, 'USD per point', M, EXP.lastBusinessDay, true, { url: cmeUrl('interest-rates/stirs/one-month-sofr'), roll: 3, note: 'Nearest expiring month ticks in 0.0025 ($6.25).' }],
    // TODO(verify): SR3 last trading day (business day before the 3rd Wednesday ending the reference quarter).
    ['3-Month SOFR', 'SR3', 'CME', 0.005, 12.5, 2500, 'USD per point', Q, { kind: 'nthWeekday', n: 3, weekday: 3, monthOffset: 3, bdBefore: 1 }, false, { url: cmeUrl('interest-rates/stirs/three-month-sofr'), listed: 12, note: 'Nearest expiring contract ticks in 0.0025 ($6.25).' }],
    // TODO(verify): Micro Treasury Yield futures tick, listing cycle and last trading day.
    ['10-Year Yield', '10Y', 'CBOT', 0.001, 1, 1000, 'USD per point', M, EXP.lastBusinessDay, false, { note: yieldNote, listed: 2 }],
    ['2-Year Yield', '2YY', 'CBOT', 0.001, 1, 1000, 'USD per point', M, EXP.lastBusinessDay, false, { note: yieldNote, listed: 2 }],
    ['5-Year Yield', '5YY', 'CBOT', 0.001, 1, 1000, 'USD per point', M, EXP.lastBusinessDay, false, { note: yieldNote, listed: 2 }],
    ['30-Year Yield', '30Y', 'CBOT', 0.001, 1, 1000, 'USD per point', M, EXP.lastBusinessDay, false, { note: yieldNote, listed: 2 }],
    ['Ultra 10-Year T-Note', 'TN', 'CBOT', 0.015625, 15.625, 100000, 'USD face', Q, EXP.longTreasury, true, { url: T('ultra-10-year-us-treasury-note') }],
    ['Ultra T-Bond', 'UB', 'CBOT', 0.03125, 31.25, 100000, 'USD face', Q, EXP.longTreasury, true, { url: T('ultra-t-bond') }],
  ]),
  ...rows('Interest Rates', SESSIONS.eurexRates, 5, [
    ['Euro Bobl', 'FGBM', 'EUREX', 0.01, 10, 100000, 'EUR face', Q, EXP.eurexBond, true, { currency: 'EUR' }],
    ['Euro Bund', 'FGBL', 'EUREX', 0.01, 10, 100000, 'EUR face', Q, EXP.eurexBond, true, { currency: 'EUR' }],
    ['Euro Buxl', 'FGBX', 'EUREX', 0.02, 20, 100000, 'EUR face', Q, EXP.eurexBond, true, { currency: 'EUR' }],
    ['Euro Schatz', 'FGBS', 'EUREX', 0.005, 5, 100000, 'EUR face', Q, EXP.eurexBond, true, { currency: 'EUR' }],
  ]),
];

const ENERGY = rows('Energy', SESSIONS.cmeEnergy, 4, [
  ['E-mini Crude Oil', 'QM', 'NYMEX', 0.025, 12.5, 500, 'bbl', M, EXP.crudeMini, true, { url: cmeUrl('energy/crude-oil/emini-crude-oil') }],
  ['E-mini Natural Gas', 'QG', 'NYMEX', 0.005, 12.5, 2500, 'MMBtu', M, EXP.natgasMini, true, { url: cmeUrl('energy/natural-gas/emini-natural-gas') }],
  ['Heating Oil', 'HO', 'NYMEX', 0.0001, 4.2, 42000, 'gal', M, EXP.products, true, { url: cmeUrl('energy/refined-products/heating-oil'), aliases: ['NY Harbor ULSD'] }],
  ['Light Sweet Crude', 'CL', 'NYMEX', 0.01, 10, 1000, 'bbl', M, EXP.crude, true, { url: cmeUrl('energy/crude-oil/light-sweet-crude'), sim: 'mock:CLZ6', aliases: ['WTI', 'Crude Oil'] }],
  ['Micro WTI Crude', 'MCL', 'NYMEX', 0.01, 1, 100, 'bbl', M, EXP.crudeMini, true, { url: cmeUrl('energy/crude-oil/micro-wti-crude-oil') }],
  ['Natural Gas', 'NG', 'NYMEX', 0.001, 10, 10000, 'MMBtu', M, EXP.natgas, true, { url: cmeUrl('energy/natural-gas/natural-gas'), aliases: ['Henry Hub'] }],
  ['RBOB Gasoline', 'RB', 'NYMEX', 0.0001, 4.2, 42000, 'gal', M, EXP.products, true, { url: cmeUrl('energy/refined-products/rbob-gasoline') }],
]);

const EQ = (p: string) => cmeUrl(`equities/${p}`);
// TODO(verify): the "E-nano" index contracts in Appendix A have no root there and the author could
// not confirm their listing venue or contract size — placeholders only.
const nano = (name: string, root: string): Row => [name, root, 'CME', 0.25, 0.125, 0.5, 'USD per point', Q, EXP.thirdFriday, false, { note: 'Placeholder: root, venue and contract size unconfirmed.' }];
const EQUITY_INDEX = [
  ...rows('Equity Index', SESSIONS.eurexEquity, 3, [
    ['DAX', 'FDAX', 'EUREX', 1, 25, 25, 'EUR per point', Q, EXP.thirdFriday, true, { currency: 'EUR' }],
    ['Euro STOXX 50', 'FESX', 'EUREX', 1, 10, 10, 'EUR per point', Q, EXP.thirdFriday, true, { currency: 'EUR' }],
    ['Micro DAX', 'FDXS', 'EUREX', 1, 1, 1, 'EUR per point', Q, EXP.thirdFriday, true, { currency: 'EUR' }],
    // TODO(verify): Micro Euro STOXX 50 tick (0.5 or 1 point).
    ['Micro Euro STOXX 50', 'FSXE', 'EUREX', 1, 1, 1, 'EUR per point', Q, EXP.thirdFriday, false, { currency: 'EUR' }],
    ['Mini DAX', 'FDXM', 'EUREX', 1, 5, 5, 'EUR per point', Q, EXP.thirdFriday, true, { currency: 'EUR' }],
    // TODO(verify): VSTOXX futures tick / hours.
    ['VSTOXX', 'FVS', 'EUREX', 0.05, 5, 100, 'EUR per point', M, EXP.vix, false, { currency: 'EUR', sessions: SESSIONS.eurexVol, listed: 6 }],
  ]),
  ...rows('Equity Index', SESSIONS.cmeEquity, 8, [
    ['E-mini Nasdaq-100', 'NQ', 'CME', 0.25, 5, 20, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('nasdaq/e-mini-nasdaq-100'), sim: 'mock:NQZ6' }],
    ['E-mini S&P 500', 'ES', 'CME', 0.25, 12.5, 50, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('sp/e-mini-sandp500'), sim: 'mock:ESZ6', aliases: ['SP500', 'S and P', 'SPX'] }],
    ['E-mini S&P MidCap 400', 'EMD', 'CME', 0.1, 10, 100, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('sp/e-mini-sandp-midcap-400') }],
    nano('E-nano DJIA', 'NYM-DJ'),
    nano('E-nano Nasdaq-100', 'NNQ'),
    nano('E-nano Russell 2000', 'NRTY'),
    nano('E-nano S&P 500', 'NES'),
    ['Micro E-mini Dow', 'MYM', 'CBOT', 1, 0.5, 0.5, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('dow-jones/micro-e-mini-dow') }],
    ['Micro E-mini Nasdaq-100', 'MNQ', 'CME', 0.25, 0.5, 2, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('nasdaq/micro-e-mini-nasdaq-100') }],
    ['Micro E-mini Russell 2000', 'M2K', 'CME', 0.1, 0.5, 5, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('russell/micro-e-mini-russell-2000') }],
    ['Micro E-mini S&P 500', 'MES', 'CME', 0.25, 1.25, 5, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('sp/micro-e-mini-sandp-500') }],
    ['Mini Russell 2000', 'RTY', 'CME', 0.1, 5, 50, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('russell/e-mini-russell-2000'), aliases: ['E-mini Russell 2000'] }],
    ['Mini-sized Dow $5', 'YM', 'CBOT', 1, 5, 5, 'USD per point', Q, EXP.thirdFriday, true, { url: EQ('dow-jones/e-mini-dow'), aliases: ['E-mini Dow', 'DJIA'] }],
    // TODO(verify): Nikkei/USD last trading day (business day before the 2nd Friday).
    ['Nikkei/USD', 'NKD', 'CME', 5, 25, 5, 'USD per point', Q, { kind: 'nthWeekday', n: 2, weekday: 5, bdBefore: 1 }, false, { url: EQ('international-indices/nikkei-225-dollar'), aliases: ['Nikkei 225'] }],
  ]),
];

const FXU = (p: string) => cmeUrl(`fx/${p}`);
const CR = (p: string) => cmeUrl(`cryptocurrencies/${p}`);
const FX = [
  ...rows('FX', SESSIONS.cmeFx, 5, [
    ['Australian Dollar', '6A', 'CME', 0.00005, 5, 100000, 'AUD', Q, EXP.fx, true, { url: FXU('g10/australian-dollar'), aliases: ['AUD/USD', 'AUDUSD'] }],
    // TODO(verify): Brazilian real tick and last trading day.
    ['Brazilian Real', '6L', 'CME', 0.00005, 5, 100000, 'BRL', M, { kind: 'lastBusinessDay', monthOffset: -1 }, false, { aliases: ['BRL/USD'] }],
    ['British Pound', '6B', 'CME', 0.0001, 6.25, 62500, 'GBP', Q, EXP.fx, true, { url: FXU('g10/british-pound'), aliases: ['GBP/USD', 'GBPUSD', 'Cable'] }],
    ['Canadian Dollar', '6C', 'CME', 0.00005, 5, 100000, 'CAD', Q, EXP.fx, true, { url: FXU('g10/canadian-dollar'), aliases: ['CAD/USD'] }],
    ['E-mini Euro', 'E7', 'CME', 0.0001, 6.25, 62500, 'EUR', Q, EXP.fx, true],
    ['Euro FX', '6E', 'CME', 0.00005, 6.25, 125000, 'EUR', Q, EXP.fx, true, { url: FXU('g10/euro-fx'), aliases: ['EUR/USD', 'EURUSD'] }],
    // TODO(verify): cross-rate ticks (quoted in the second currency).
    ['Euro/British Pound', 'RP', 'CME', 0.00005, 6.25, 125000, 'EUR', Q, EXP.fx, false, { currency: 'GBP', aliases: ['EUR/GBP'] }],
    ['Euro/Japanese Yen', 'RY', 'CME', 0.01, 1250, 125000, 'EUR', Q, EXP.fx, false, { currency: 'JPY', aliases: ['EUR/JPY'] }],
    ['Japanese Yen', '6J', 'CME', 0.0000005, 6.25, 12500000, 'JPY', Q, EXP.fx, true, { url: FXU('g10/japanese-yen'), aliases: ['JPY/USD', 'USDJPY'] }],
    ['Mexican Peso', '6M', 'CME', 0.00001, 5, 500000, 'MXN', Q, EXP.fx, true, { url: FXU('emerging-market/mexican-peso'), aliases: ['MXN/USD'] }],
    ['Micro AUD/USD', 'M6A', 'CME', 0.0001, 1, 10000, 'AUD', Q, EXP.fx, true],
    // TODO(verify): Micro CAD/USD and Micro JPY/USD ticks.
    ['Micro CAD/USD', 'MCD', 'CME', 0.0001, 1, 10000, 'CAD', Q, EXP.fx, false],
    ['Micro EUR/USD', 'M6E', 'CME', 0.0001, 1.25, 12500, 'EUR', Q, EXP.fx, true],
    ['Micro GBP/USD', 'M6B', 'CME', 0.0001, 0.625, 6250, 'GBP', Q, EXP.fx, true],
    ['Micro JPY/USD', 'MJY', 'CME', 0.000001, 1.25, 1250000, 'JPY', Q, EXP.fx, false],
    ['New Zealand Dollar', '6N', 'CME', 0.00005, 5, 100000, 'NZD', Q, EXP.fx, true, { url: FXU('g10/new-zealand-dollar'), aliases: ['NZD/USD'] }],
    // TODO(verify): rouble futures (trading suspended in 2022) and rand tick sizes.
    ['Russian Ruble', '6R', 'CME', 0.000005, 12.5, 2500000, 'RUB', Q, EXP.fx, false, { note: 'Listing status must be checked: trading was suspended in 2022.', aliases: ['RUB/USD'] }],
    ['South African Rand', '6Z', 'CME', 0.0000025, 1.25, 500000, 'ZAR', Q, EXP.fx, false, { aliases: ['ZAR/USD'] }],
    ['Swiss Franc', '6S', 'CME', 0.00005, 6.25, 125000, 'CHF', Q, EXP.fx, true, { url: FXU('g10/swiss-franc'), aliases: ['CHF/USD'] }],
  ]),
  ...rows('FX', SESSIONS.cmeCrypto, 5, [
    ['Bitcoin', 'BTC', 'CME', 5, 25, 5, 'BTC', M, EXP.lastFriday, true, { url: CR('bitcoin/bitcoin'), listed: 6, aliases: ['CME Bitcoin', 'XBT'] }],
    ['Ether', 'ETH', 'CME', 0.5, 25, 50, 'ETH', M, EXP.lastFriday, true, { url: CR('ether/ether'), listed: 6, aliases: ['Ethereum'] }],
    ['Micro Bitcoin', 'MBT', 'CME', 5, 0.5, 0.1, 'BTC', M, EXP.lastFriday, true, { url: CR('bitcoin/micro-bitcoin'), listed: 6 }],
    ['Micro Ether', 'MET', 'CME', 0.5, 0.05, 0.1, 'ETH', M, EXP.lastFriday, true, { url: CR('ether/micro-ether'), listed: 6 }],
  ]),
  ...rows('FX', SESSIONS.iceDx, 5, [
    ['US Dollar Index', 'DX', 'ICE US', 0.005, 5, 1000, 'USD per point', Q, EXP.fx, true, { aliases: ['DXY', 'Dollar Index'] }],
  ]),
];

const MT = (p: string) => cmeUrl(`metals/${p}`);
const METALS = rows('Metals', SESSIONS.cmeMetals, 30, [
  // TODO(verify): 1-Ounce Gold tick and listing cycle.
  ['1-Ounce Gold', '1OZ', 'COMEX', 0.25, 0.25, 1, 'troy oz', M, EXP.metals, false, { listed: 4 }],
  ['COMEX Copper', 'HG', 'COMEX', 0.0005, 12.5, 25000, 'lb', GRAIN, EXP.metals, true, { url: MT('base/copper') }],
  ['E-micro Gold', 'MGC', 'COMEX', 0.1, 1, 10, 'troy oz', 'GJMQVZ', EXP.metals, true, { url: MT('precious/e-micro-gold'), aliases: ['Micro Gold'] }],
  ['COMEX Gold', 'GC', 'COMEX', 0.1, 10, 100, 'troy oz', 'GJMQVZ', EXP.metals, true, { url: MT('precious/gold'), sim: 'mock:GCZ6' }],
  ['COMEX Silver', 'SI', 'COMEX', 0.005, 25, 5000, 'troy oz', GRAIN, EXP.metals, true, { url: MT('precious/silver') }],
  ['E-mini Copper', 'QC', 'COMEX', 0.002, 25, 12500, 'lb', GRAIN, EXP.metals, true],
  ['E-mini Silver', 'QI', 'COMEX', 0.0125, 31.25, 2500, 'troy oz', GRAIN, EXP.metals, true],
  ['Micro Copper', 'MHG', 'COMEX', 0.0005, 1.25, 2500, 'lb', GRAIN, EXP.metals, true],
  ['Micro Silver', 'SIL', 'COMEX', 0.005, 5, 1000, 'troy oz', GRAIN, EXP.metals, true],
  // TODO(verify): CBOT mini metals — listing status and ticks.
  ['Mini Silver', 'YI', 'CBOT', 0.001, 1, 1000, 'troy oz', GRAIN, EXP.metals, false],
  ['Mini-sized Gold', 'YG', 'CBOT', 0.1, 3.32, 33.2, 'troy oz', 'GJMQVZ', EXP.metals, false],
  // TODO(verify): palladium tick ($0.50 = $50).
  ['Palladium', 'PA', 'NYMEX', 0.5, 50, 100, 'troy oz', Q, EXP.metals, false, { url: MT('precious/palladium') }],
]);

export const FUTURES: CatalogInstrument[] = [
  ...AGRICULTURAL,
  ...INTEREST_RATES,
  ...ENERGY,
  ...EQUITY_INDEX,
  ...FX,
  ...METALS,
];
