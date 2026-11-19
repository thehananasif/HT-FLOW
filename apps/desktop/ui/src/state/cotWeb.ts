import type { CotReport } from '../charts/layers/cotMarkets';
import type { CotFetchArgs, CotGroup, CotNativeResult, CotRow } from './cot';

/**
 * COT download for the web build: the CFTC Socrata API sends `Access-Control-Allow-Origin: *`, so
 * the browser can query it directly (the desktop app uses the Rust `cot` crate instead; this is a
 * port of its URL builder and row parser, kept in step with `crates/cot/src/lib.rs`).
 */
export const CFTC_HOST = 'publicreporting.cftc.gov';
const MAX_ROWS = 3000;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

interface GroupSpec {
  key: string;
  label: string;
  long: string;
  short: string;
  spread?: string;
  dLong: string;
  dShort: string;
}

const NONREPT: GroupSpec = {
  key: 'nonreportable',
  label: 'Non-reportable',
  long: 'nonrept_positions_long_all',
  short: 'nonrept_positions_short_all',
  dLong: 'change_in_nonrept_long_all',
  dShort: 'change_in_nonrept_short_all',
};
const OTHER: GroupSpec = {
  key: 'other',
  label: 'Other reportables',
  long: 'other_rept_positions_long',
  short: 'other_rept_positions_short',
  spread: 'other_rept_positions_spread',
  dLong: 'change_in_other_rept_long',
  dShort: 'change_in_other_rept_short',
};

export const COT_WEB_REPORTS: Record<CotReport, { dataset: string; groups: GroupSpec[] }> = {
  legacy: {
    dataset: '6dca-aqww',
    groups: [
      {
        key: 'commercial',
        label: 'Commercials',
        long: 'comm_positions_long_all',
        short: 'comm_positions_short_all',
        dLong: 'change_in_comm_long_all',
        dShort: 'change_in_comm_short_all',
      },
      {
        key: 'noncommercial',
        label: 'Non-commercials',
        long: 'noncomm_positions_long_all',
        short: 'noncomm_positions_short_all',
        spread: 'noncomm_postions_spread_all',
        dLong: 'change_in_noncomm_long_all',
        dShort: 'change_in_noncomm_short_all',
      },
      NONREPT,
    ],
  },
  disagg: {
    dataset: '72hh-3qpy',
    groups: [
      {
        key: 'producer',
        label: 'Producers / merchants',
        long: 'prod_merc_positions_long',
        short: 'prod_merc_positions_short',
        dLong: 'change_in_prod_merc_long',
        dShort: 'change_in_prod_merc_short',
      },
      {
        key: 'swap',
        label: 'Swap dealers',
        long: 'swap_positions_long_all',
        short: 'swap__positions_short_all',
        spread: 'swap__positions_spread_all',
        dLong: 'change_in_swap_long_all',
        dShort: 'change_in_swap_short_all',
      },
      {
        key: 'managed',
        label: 'Managed money',
        long: 'm_money_positions_long_all',
        short: 'm_money_positions_short_all',
        spread: 'm_money_positions_spread',
        dLong: 'change_in_m_money_long_all',
        dShort: 'change_in_m_money_short_all',
      },
      OTHER,
      NONREPT,
    ],
  },
  tff: {
    dataset: 'gpe5-46if',
    groups: [
      {
        key: 'dealer',
        label: 'Dealers / intermediaries',
        long: 'dealer_positions_long_all',
        short: 'dealer_positions_short_all',
        spread: 'dealer_positions_spread_all',
        dLong: 'change_in_dealer_long_all',
        dShort: 'change_in_dealer_short_all',
      },
      {
        key: 'assetmgr',
        label: 'Asset managers',
        long: 'asset_mgr_positions_long',
        short: 'asset_mgr_positions_short',
        spread: 'asset_mgr_positions_spread',
        dLong: 'change_in_asset_mgr_long',
        dShort: 'change_in_asset_mgr_short',
      },
      {
        key: 'levmoney',
        label: 'Leveraged funds',
        long: 'lev_money_positions_long',
        short: 'lev_money_positions_short',
        spread: 'lev_money_positions_spread',
        dLong: 'change_in_lev_money_long',
        dShort: 'change_in_lev_money_short',
      },
      OTHER,
      NONREPT,
    ],
  },
};

export class CotWebError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The CFTC query URL for one market, oldest first, only the fields that are read. */
export function buildCotUrl(report: CotReport, marketCode: string, fromDate: string): string {
  if (!/^[A-Za-z0-9]{1,8}$/.test(marketCode))
    throw new CotWebError('cot.bad_market', 'Not a CFTC contract market code');
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fromDate))
    throw new CotWebError('cot.bad_date', 'Date must be YYYY-MM-DD');
  const spec = COT_WEB_REPORTS[report];
  if (!spec) throw new CotWebError('cot.bad_report', 'Unknown COT report type');
  const fields = ['report_date_as_yyyy_mm_dd', 'open_interest_all', 'change_in_open_interest_all'];
  for (const g of spec.groups) {
    fields.push(g.long, g.short, g.dLong, g.dShort);
    if (g.spread) fields.push(g.spread);
  }
  const where = `cftc_contract_market_code='${marketCode}' AND report_date_as_yyyy_mm_dd>='${fromDate}'`;
  return (
    `https://${CFTC_HOST}/resource/${spec.dataset}.json` +
    `?$select=${encodeURIComponent(fields.join(','))}` +
    `&$where=${encodeURIComponent(where)}` +
    `&$order=report_date_as_yyyy_mm_dd%20ASC&$limit=${MAX_ROWS}`
  );
}

function int(r: Record<string, unknown>, field: string): number {
  const v = r[field];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v.trim()) : 0;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Parses the JSON array of a Socrata response into weekly rows (ascending, one per date). */
export function parseCotRows(report: CotReport, json: string): CotRow[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new CotWebError('cot.parse', 'The CFTC response is not valid JSON');
  }
  if (!Array.isArray(v)) {
    const msg =
      v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string'
        ? (v as { message: string }).message
        : 'The CFTC API returned an error';
    throw new CotWebError('cot.api', msg);
  }
  const spec = COT_WEB_REPORTS[report];
  const rows: CotRow[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const d = r.report_date_as_yyyy_mm_dd;
    if (typeof d !== 'string' || r.open_interest_all === undefined) continue;
    const date = d.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const groups: CotGroup[] = spec.groups.map((g) => {
      const long = int(r, g.long);
      const short = int(r, g.short);
      const dl = int(r, g.dLong);
      const ds = int(r, g.dShort);
      return {
        key: g.key,
        label: g.label,
        long,
        short,
        spread: g.spread ? int(r, g.spread) : 0,
        net: long - short,
        longChange: dl,
        shortChange: ds,
        netChange: dl - ds,
      };
    });
    rows.push({
      date,
      openInterest: int(r, 'open_interest_all'),
      oiChange: int(r, 'change_in_open_interest_all'),
      groups,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows.filter((row, i) => i === 0 || rows[i - 1]!.date !== row.date);
}

/** Browser download of one market's weekly history (web build only). */
export async function cotFetchWeb(
  a: CotFetchArgs,
  doFetch: typeof fetch = (...x) => fetch(...x),
): Promise<CotNativeResult> {
  const url = buildCotUrl(a.report, a.marketCode, a.fromDate);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
  } catch {
    throw new CotWebError('cot.network', 'Could not connect to the CFTC');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new CotWebError('cot.http', `The CFTC server answered HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BODY_CHARS)
    throw new CotWebError('cot.too_large', 'The CFTC response is too large');
  return { rows: parseCotRows(a.report, body), fetchedAt: Date.now(), source: 'network' };
}
