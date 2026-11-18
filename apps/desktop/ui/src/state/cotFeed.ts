import type { CotData } from '@htflow/indicator-sdk';
import { cotMarketFor, cotReportFor, type CotReport } from '../charts/layers/cotMarkets';
import { cotKey, useCot, type CotEntry } from './cot';
import { getSetting } from './settings';

/**
 * COT history for the indicator context of one chart: the weekly CFTC rows of the chart's symbol
 * (default report from Settings). Loaded lazily, only once a COT indicator is on the chart.
 */
export function createCotFeed(symbol: string, onChange: () => void) {
  const market = cotMarketFor(symbol);
  const report = (): CotReport =>
    market ? cotReportFor(market, getSetting('data.cotReport') as CotReport) : 'legacy';
  let version = 0;
  let last: CotEntry | undefined;
  let cached: CotData | undefined;
  let started = false;
  const entry = () =>
    market ? useCot.getState().entries[cotKey(report(), market.code)] : undefined;
  const unsub = useCot.subscribe(() => {
    if (entry() !== last) onChange();
  });
  return {
    /** Starts the download (once); returns false when the symbol has no CFTC market. */
    ensure(): boolean {
      if (!market) return false;
      if (!started) {
        started = true;
        void useCot
          .getState()
          .load(report(), market.code, 10, false, !getSetting('data.cotAutoRefresh'));
      }
      return true;
    },
    data(): CotData | undefined {
      const e = entry();
      if (!market || !e || !e.rows.length) return undefined;
      if (e !== last) {
        last = e;
        version++;
        cached = {
          version,
          report: report(),
          market: market.code,
          weeks: e.rows.map((r) => ({
            t: Date.parse(r.date + 'T00:00:00Z'),
            openInterest: r.openInterest,
            groups: r.groups.map((g) => ({
              key: g.key,
              label: g.label,
              long: g.long,
              short: g.short,
              net: g.net,
              netChange: g.netChange,
            })),
          })),
        };
      }
      return cached;
    },
    detach: unsub,
  };
}
