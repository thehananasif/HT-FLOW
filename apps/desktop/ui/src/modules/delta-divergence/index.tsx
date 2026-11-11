import { useEffect, useRef } from 'react';
import { Checkbox, Chip, Input, toast } from '@htflow/ui-kit';
import { formatPrice } from '@htflow/market-data';
import {
  DIVERGENCE_TIMEFRAMES,
  conditionText,
  normalizeDivergenceOptions,
  scanDivergences,
  tfLabel,
  type DivergenceSignal,
} from '@htflow/analytics';
import { registerModule, type ModuleViewProps } from '../registry';
import { beep, fmtTime } from '../smart-tape/shared';
import {
  CommonSettings,
  ScannerFrame,
  ScannerTable,
  openOnChart,
  scannerIds,
  sortParams,
  useAnalytics,
  type ScanColumn,
} from '../market-pressure/scanner';

interface Row {
  key: string;
  id: string;
  sym: string;
  s: DivergenceSignal;
  text: string;
}

const MAX_ROWS = 300;

function DeltaDivergence({ state, setParams }: ModuleViewProps) {
  const raw = state.params ?? {};
  const ids = scannerIds(raw.ids);
  const tf =
    typeof raw.tf === 'number' && DIVERGENCE_TIMEFRAMES.some((t) => t.ms === raw.tf) ? raw.tf : 0;
  const opts = normalizeDivergenceOptions(raw);
  const alerts = raw.alerts === true;
  const sort = sortParams(raw, 'time');
  const list = useAnalytics(ids);
  const rows: Row[] = [];
  for (const a of list) {
    for (const series of a.series) {
      if (tf && series.tfMs !== tf) continue;
      for (const s of scanDivergences(series.bars, series.tfMs, opts)) {
        rows.push({
          key: `${a.instrument.id}|${s.tfMs}|${s.t}|${s.code}`,
          id: a.instrument.id,
          sym: a.instrument.symbol,
          s,
          text: conditionText(s, (px) => formatPrice(px, a.instrument)),
        });
      }
    }
  }
  rows.sort((x, y) => y.s.t + y.s.tfMs - (x.s.t + x.s.tfMs));
  rows.length = Math.min(rows.length, MAX_ROWS);

  // Alert only on signals that appear while the window is open (not on history).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!list.length) return;
    if (!seen.current) {
      seen.current = new Set(rows.map((r) => r.key));
      return;
    }
    for (const r of rows) {
      if (seen.current.has(r.key)) continue;
      seen.current.add(r.key);
      if (alerts) {
        toast(
          r.s.kind === 'bullish' ? 'success' : 'warning',
          `${r.sym} ${tfLabel(r.s.tfMs)} ${r.s.kind}`,
          r.text,
        );
        beep(r.s.kind === 'bullish' ? 1 : -1);
      }
    }
  });

  const columns: ScanColumn<Row>[] = [
    {
      id: 'sym',
      label: 'Symbol',
      sort: (r) => r.sym,
      cell: (r) => <span className="scan-sym">{r.sym}</span>,
      align: 'left',
    },
    {
      id: 'tf',
      label: 'TF',
      sort: (r) => r.s.tfMs,
      cell: (r) => <span className="muted">{tfLabel(r.s.tfMs)}</span>,
      align: 'left',
      width: '0.5fr',
    },
    {
      id: 'type',
      label: 'Type',
      sort: (r) => r.s.kind,
      cell: (r) =>
        r.s.kind === 'bearish' ? (
          <span className="down scan-strong">▼ Bearish</span>
        ) : (
          <span className="up scan-strong">▲ Bullish</span>
        ),
      align: 'left',
      width: '0.9fr',
    },
    {
      id: 'cond',
      label: 'Condition',
      sort: (r) => r.text,
      cell: (r) => r.text,
      align: 'left',
      width: '2fr',
    },
    {
      id: 'time',
      label: 'Time',
      sort: (r) => r.s.t,
      cell: (r) => <span className="muted">{fmtTime(r.s.t, false).slice(0, 5)}</span>,
      width: '0.6fr',
    },
  ];

  return (
    <ScannerFrame
      testId="delta-divergence"
      subtitle="price vs CVD"
      chips={[{ id: 'M', ms: 0 }, ...DIVERGENCE_TIMEFRAMES].map((t) => (
        <Chip key={t.ms} selected={tf === t.ms} onClick={() => setParams({ tf: t.ms })}>
          {t.ms ? t.id : 'All TF'}
        </Chip>
      ))}
      settings={
        <CommonSettings
          ids={ids}
          alerts={alerts}
          onIds={(v) => setParams({ ids: v })}
          onAlerts={(v) => setParams({ alerts: v })}
          onReset={() =>
            setParams({ ids: undefined, alerts: false, tf: 0, lookback: 10, absorption: false })
          }
        >
          <label>
            Swing lookback (bars, 2–100)
            <Input
              type="number"
              min={2}
              max={100}
              value={opts.lookback}
              onChange={(e) => setParams({ lookback: Number(e.target.value) })}
            />
          </label>
          <Checkbox
            checked={opts.absorption}
            onChange={(v) => setParams({ absorption: v })}
            label="Also CVD-led divergences (absorption)"
          />
        </CommonSettings>
      }
      footer={`Bearish: price makes a higher high over the last ${opts.lookback} bars while CVD makes a lower high; bullish is the mirror · newest first · click a row to open its chart on that timeframe`}
    >
      <ScannerTable
        rows={rows}
        columns={columns}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onSort={(sortKey, sortDir) => setParams({ sortKey, sortDir })}
        onRowClick={(r) => openOnChart(r.id, r.s.tfMs)}
        empty={ids.length ? 'No divergences yet' : 'No instruments selected (⚙)'}
      />
    </ScannerFrame>
  );
}

registerModule({ id: 'delta-divergence', view: DeltaDivergence });
