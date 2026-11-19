import {
  COT_MARKETS,
  cotMarketFor,
  cotReportFor,
  type CotMarket,
  type CotReport,
} from './cotMarkets';
import { COT_SAMPLE } from './cotSample';
import type { ChartTypeSettings } from './settings';
import { cotKey, isCotStale, type CotEntry, type CotRow } from '../../state/cot';

/** What the COT chart shows right now, and why. */
export interface CotData {
  rows: CotRow[];
  /** Bundled synthetic rows (offline with no cache): always labelled "Sample data". */
  sample: boolean;
  status: CotEntry['status'] | 'no-market';
  market: CotMarket | null;
  report: CotReport;
  fetchedAt: number;
  source?: CotEntry['source'];
  /** One line for the status bar / legend. */
  message: string;
}

/** The market + report a chart window asks for (symbol mapping, user override, default report). */
export function resolveCot(
  cot: ChartTypeSettings['cot'],
  symbol: string,
  defaultReport: CotReport,
): { market: CotMarket | null; report: CotReport } {
  const market =
    cot.market === 'auto'
      ? cotMarketFor(symbol)
      : (COT_MARKETS.find((m) => m.root === cot.market) ?? cotMarketFor(symbol));
  if (!market) return { market: null, report: defaultReport };
  const wanted = cot.report === 'auto' ? defaultReport : cot.report;
  // An explicit report the market lacks is kept (the chart then says "no data"); auto adapts.
  return { market, report: cot.report === 'auto' ? cotReportFor(market, wanted) : wanted };
}

/** Bundled sample rows in the Legacy layout (synthetic, offline fallback only). */
export function sampleRows(): CotRow[] {
  return COT_SAMPLE.map((r) => {
    const g = (key: string, label: string, long: number, short: number) => ({
      key,
      label,
      long,
      short,
      spread: 0,
      net: long - short,
      longChange: 0,
      shortChange: 0,
      netChange: 0,
    });
    return {
      date: r[0],
      openInterest: r[8],
      oiChange: 0,
      groups: [
        g('commercial', 'Commercials', r[2], r[3]),
        g('noncommercial', 'Non-commercials', r[4], r[5]),
        g('nonreportable', 'Non-reportable', r[6], r[7]),
      ],
    };
  }).map((row, i, all) => {
    const prev = all[i - 1];
    if (!prev) return row;
    return {
      ...row,
      oiChange: row.openInterest - prev.openInterest,
      groups: row.groups.map((gr, k) => ({
        ...gr,
        netChange: gr.net - prev.groups[k]!.net,
      })),
    };
  });
}

const ago = (ms: number) => {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
};

/** Combines the store entry (or its absence) into what the chart draws. */
export function cotData(
  entries: Record<string, CotEntry>,
  market: CotMarket | null,
  report: CotReport,
): CotData {
  const base = { market, report, fetchedAt: 0 };
  if (!market)
    return {
      ...base,
      rows: [],
      sample: false,
      status: 'no-market',
      message: 'No CFTC market is mapped to this symbol: pick one in the COT bar',
    };
  const e = entries[cotKey(report, market.code)];
  if (!e || (e.status === 'loading' && !e.rows.length))
    return { ...base, rows: [], sample: false, status: 'loading', message: 'Loading COT data…' };
  if (e.status === 'offline')
    return {
      ...base,
      rows: sampleRows(),
      sample: true,
      status: 'offline',
      message: `Offline, no cached COT data (${e.error ?? 'no connection'}): showing a bundled sample`,
    };
  if (e.status === 'error')
    return {
      ...base,
      rows: [],
      sample: false,
      status: 'error',
      message: e.error ?? 'COT download failed',
    };
  if (e.status === 'empty')
    return {
      ...base,
      rows: [],
      sample: false,
      status: 'empty',
      message: `${market.name} has no ${report.toUpperCase()} report rows: try ${market.reports
        .filter((r) => r !== report)
        .join(' / ')}`,
    };
  const stale = e.source === 'stale-cache';
  const last = e.rows[e.rows.length - 1]?.date ?? '';
  const msg = stale
    ? `Cached ${ago(e.fetchedAt)} (CFTC unreachable: ${e.warning ?? 'offline'}) · as of ${last}`
    : `CFTC ${e.source === 'cache' ? 'cache' : 'download'} ${ago(e.fetchedAt)} · as of ${last}${
        isCotStale(e.fetchedAt) ? ' · newer report due' : ''
      }`;
  return {
    ...base,
    rows: e.rows,
    sample: false,
    status: e.status,
    fetchedAt: e.fetchedAt,
    source: e.source,
    message: msg,
  };
}
