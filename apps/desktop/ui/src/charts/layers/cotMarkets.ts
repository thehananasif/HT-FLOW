/**
 * Catalog futures roots -> CFTC contract market codes (verified live against the public
 * reporting API). Financial futures are in the Legacy and TFF reports, physical commodities in
 * the Legacy and Disaggregated reports, so each row lists the reports that have data for it.
 * Micro contracts (MES, MNQ, ...) report under their full-size parent.
 */
export type CotReport = 'legacy' | 'disagg' | 'tff';

export const COT_REPORTS: { id: CotReport; label: string; help: string }[] = [
  { id: 'legacy', label: 'Legacy', help: 'Commercial / non-commercial / non-reportable' },
  {
    id: 'disagg',
    label: 'Disaggregated',
    help: 'Producers, swap dealers, managed money (commodities)',
  },
  { id: 'tff', label: 'TFF', help: 'Dealers, asset managers, leveraged funds (financials)' },
];

export interface CotMarket {
  root: string;
  code: string;
  name: string;
  reports: CotReport[];
}

const FIN: CotReport[] = ['tff', 'legacy'];
const COM: CotReport[] = ['disagg', 'legacy'];

export const COT_MARKETS: CotMarket[] = [
  { root: 'ES', code: '13874A', name: 'E-mini S&P 500', reports: FIN },
  { root: 'NQ', code: '209742', name: 'E-mini Nasdaq-100', reports: FIN },
  { root: 'YM', code: '124603', name: 'E-mini Dow ($5)', reports: FIN },
  { root: 'RTY', code: '239742', name: 'E-mini Russell 2000', reports: FIN },
  { root: 'VX', code: '1170E1', name: 'VIX futures', reports: ['legacy'] },
  { root: 'CL', code: '067651', name: 'Crude oil (WTI)', reports: COM },
  { root: 'NG', code: '023651', name: 'Natural gas', reports: COM },
  { root: 'HO', code: '022651', name: 'NY Harbor ULSD', reports: COM },
  { root: 'RB', code: '111659', name: 'RBOB gasoline', reports: COM },
  { root: 'GC', code: '088691', name: 'Gold', reports: COM },
  { root: 'SI', code: '084691', name: 'Silver', reports: COM },
  { root: 'HG', code: '085692', name: 'Copper', reports: COM },
  { root: 'PL', code: '076651', name: 'Platinum', reports: COM },
  { root: 'PA', code: '075651', name: 'Palladium', reports: COM },
  { root: 'ZB', code: '020601', name: 'U.S. Treasury bond', reports: FIN },
  { root: 'ZN', code: '043602', name: '10-year T-Note', reports: FIN },
  { root: 'ZF', code: '044601', name: '5-year T-Note', reports: FIN },
  { root: 'ZT', code: '042601', name: '2-year T-Note', reports: FIN },
  { root: 'ZC', code: '002602', name: 'Corn', reports: COM },
  { root: 'ZS', code: '005602', name: 'Soybeans', reports: COM },
  { root: 'ZW', code: '001602', name: 'Wheat (SRW)', reports: COM },
  { root: 'ZL', code: '007601', name: 'Soybean oil', reports: COM },
  { root: 'ZM', code: '026603', name: 'Soybean meal', reports: COM },
  { root: 'LE', code: '057642', name: 'Live cattle', reports: COM },
  { root: 'HE', code: '054642', name: 'Lean hogs', reports: COM },
  { root: 'KC', code: '083731', name: 'Coffee C', reports: COM },
  { root: 'SB', code: '080732', name: 'Sugar No. 11', reports: COM },
  { root: 'CC', code: '073732', name: 'Cocoa', reports: COM },
  { root: 'CT', code: '033661', name: 'Cotton No. 2', reports: COM },
  { root: '6E', code: '099741', name: 'Euro FX', reports: FIN },
  { root: '6J', code: '097741', name: 'Japanese yen', reports: FIN },
  { root: '6B', code: '096742', name: 'British pound', reports: FIN },
  { root: '6C', code: '090741', name: 'Canadian dollar', reports: FIN },
  { root: '6A', code: '232741', name: 'Australian dollar', reports: FIN },
  { root: '6S', code: '092741', name: 'Swiss franc', reports: FIN },
  { root: '6M', code: '095741', name: 'Mexican peso', reports: FIN },
  { root: 'BTC', code: '133741', name: 'Bitcoin (CME)', reports: FIN },
  { root: 'ETH', code: '146021', name: 'Ether (CME)', reports: FIN },
];

/** Micro contracts and aliases -> full-size root. */
const ALIASES: Record<string, string> = {
  MES: 'ES',
  MNQ: 'NQ',
  MYM: 'YM',
  M2K: 'RTY',
  MCL: 'CL',
  MNG: 'NG',
  MGC: 'GC',
  SIL: 'SI',
  MHG: 'HG',
  M6E: '6E',
  M6B: '6B',
  M6A: '6A',
  MBT: 'BTC',
  MET: 'ETH',
  XBT: 'BTC',
  BTCUSD: 'BTC',
  BTCUSDT: 'BTC',
  BTCUSDC: 'BTC',
  ETHUSD: 'ETH',
  ETHUSDT: 'ETH',
  ETHUSDC: 'ETH',
};

/** The CFTC market for a catalog symbol / root (`ESZ6`, `MES`, `BTCUSDT`, ...), or null. */
export function cotMarketFor(symbol: string | undefined | null): CotMarket | null {
  if (!symbol) return null;
  const s = symbol.toUpperCase().replace(/^\//, '');
  const direct = COT_MARKETS.find((m) => m.root === s);
  if (direct) return direct;
  const alias = ALIASES[s];
  if (alias) return COT_MARKETS.find((m) => m.root === alias) ?? null;
  // contract month suffix: ESZ6, CLF27, 6EH26 (month letter + 1-2 digit year)
  const m = /^(.+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(s);
  if (m) return cotMarketFor(m[1]);
  return null;
}

/** Default report for a market: the first one it supports, unless the user's default is available. */
export function cotReportFor(market: CotMarket, preferred: CotReport): CotReport {
  return market.reports.includes(preferred) ? preferred : market.reports[0]!;
}
