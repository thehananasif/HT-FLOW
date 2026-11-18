import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChartWindowState } from '@htflow/workspace';
import { hub } from '../../state/market';
import { instrumentById } from '../../state/instruments';
import { COT_MARKETS, COT_REPORTS, type CotReport } from '../../charts/layers/cotMarkets';
import { cotData, resolveCot } from '../../charts/layers/cotModel';
import { readChartTypeSettings, type ChartTypeSettings } from '../../charts/layers/settings';
import { useCot } from '../../state/cot';
import { useSetting } from '../../state/settings';

/**
 * Header strip of the COT Chart: market + report pickers, refresh, and where the data comes from
 * (download / cache / offline sample). Changes are saved through `onChange` (window ext).
 */
export function CotBar({
  state,
  onChange,
}: {
  state: ChartWindowState;
  onChange: (fn: (cot: ChartTypeSettings['cot']) => void) => void;
}) {
  const st = readChartTypeSettings(state);
  const defReport = useSetting('data.cotReport') as CotReport;
  const entries = useCot((s) => s.entries);
  const symbol = (hub.peek(state.instrumentId)?.instrument ?? instrumentById(state.instrumentId))
    ?.symbol;
  const { market, report } = useMemo(
    () => resolveCot(st.cot, symbol ?? '', defReport),
    [st.cot, symbol, defReport],
  );
  const d = cotData(entries, market, report);
  const loading = d.status === 'loading';
  const reports = market ? COT_REPORTS.filter((r) => market.reports.includes(r.id)) : COT_REPORTS;
  return (
    <div className="cot-bar" data-testid="cot-bar">
      <select
        aria-label="COT market"
        data-testid="cot-market"
        value={market?.root ?? ''}
        onChange={(e) => onChange((c) => (c.market = e.target.value || 'auto'))}
      >
        {!market && <option value="">Pick a market…</option>}
        {COT_MARKETS.map((m) => (
          <option key={m.root} value={m.root}>
            {m.root} · {m.name}
          </option>
        ))}
      </select>
      <select
        aria-label="COT report"
        data-testid="cot-report"
        value={report}
        onChange={(e) => onChange((c) => (c.report = e.target.value as typeof c.report))}
      >
        {reports.map((r) => (
          <option key={r.id} value={r.id} title={r.help}>
            {r.label}
          </option>
        ))}
      </select>
      <button
        className="cot-refresh"
        data-testid="cot-refresh"
        aria-label="Refresh COT data"
        title="Download the latest COT data now"
        disabled={!market || loading}
        onClick={() =>
          market && void useCot.getState().load(report, market.code, st.cot.years, true)
        }
      >
        <RefreshCw size={11} />
      </button>
      {d.sample && <span className="ct-sample-badge">Sample data</span>}
      <span
        className={`cot-status cot-${d.status}`}
        data-testid="cot-status"
        data-status={d.status}
        title={d.message}
      >
        {d.sample ? 'Offline: no cached COT data' : d.message}
      </span>
    </div>
  );
}
