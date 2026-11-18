import { useEffect, useRef } from 'react';
import { Chip, Input, toast, theme } from '@htflow/ui-kit';
import {
  normalizeThresholds,
  pressureSignal,
  type PressureRow,
  type PressureSignal,
} from '@htflow/analytics';
import { registerModule, type ModuleViewProps } from '../registry';
import { beep, oneOf } from '../smart-tape/shared';
import {
  CommonSettings,
  ScannerFrame,
  ScannerTable,
  openOnChart,
  scannerIds,
  sortParams,
  tint,
  useAnalytics,
  type ScanColumn,
} from './scanner';

import { translateLiteral as tl } from '@htflow/i18n';
const WINDOWS = [
  { id: 'm1', label: '1m' },
  { id: 'm5', label: '5m' },
  { id: 'm15', label: '15m' },
  { id: 'session', label: 'Session' },
] as const;
type Win = (typeof WINDOWS)[number]['id'];

const SIGNAL_LABEL: Record<PressureSignal, string> = {
  'strong-buy': 'Strong buy',
  'strong-sell': 'Strong sell',
  neutral: 'Neutral',
};

interface Row {
  key: string;
  sym: string;
  pr: PressureRow;
  signal: PressureSignal;
}

function PctCell({ v }: { v: number }) {
  if (Number.isNaN(v)) return <span className="muted">—</span>;
  const t = theme();
  const c = v >= 50 ? t.up : t.down;
  return (
    <span className="scan-bar">
      <i style={{ width: `${v}%`, background: tint(c, 0.16 + (Math.abs(v - 50) / 50) * 0.2) }} />
      <b style={{ color: c }}>
        {v.toFixed(0)}
        {tl('% buy')}
      </b>
    </span>
  );
}

function MarketPressure({ state, setParams }: ModuleViewProps) {
  const raw = state.params ?? {};
  const ids = scannerIds(raw.ids);
  const win: Win = oneOf(raw.window, ['m1', 'm5', 'm15', 'session'] as const, 'm5');
  const th = normalizeThresholds((raw.thresholds ?? {}) as Record<string, unknown>);
  const alerts = raw.alerts === true;
  const sort = sortParams(raw, win);
  const list = useAnalytics(ids);
  const rows: Row[] = list.map((a) => {
    const pr = a.pressure();
    return {
      key: a.instrument.id,
      sym: a.instrument.symbol,
      pr,
      signal: pressureSignal(pr[win], th),
    };
  });

  const prev = useRef(new Map<string, PressureSignal>());
  useEffect(() => {
    for (const r of rows) {
      const before = prev.current.get(r.key);
      prev.current.set(r.key, r.signal);
      if (alerts && before && before !== r.signal && r.signal !== 'neutral') {
        toast(
          r.signal === 'strong-buy' ? 'success' : 'warning',
          `${r.sym}: ${SIGNAL_LABEL[r.signal]}`,
          `Aggressive buy ${r.pr[win].toFixed(0)}% over ${win}`,
        );
        beep(r.signal === 'strong-buy' ? 1 : -1);
      }
    }
  });

  const pctCol = (id: Win, label: string): ScanColumn<Row> => ({
    id,
    label,
    sort: (r) => r.pr[id],
    cell: (r) => <PctCell v={r.pr[id]} />,
    width: '1.2fr',
  });
  const columns: ScanColumn<Row>[] = [
    {
      id: 'sym',
      label: 'Symbol',
      sort: (r) => r.sym,
      cell: (r) => <span className="scan-sym">{r.sym}</span>,
      align: 'left',
    },
    pctCol('m1', '1m'),
    pctCol('m5', '5m'),
    pctCol('m15', '15m'),
    pctCol('session', 'Session'),
    {
      id: 'signal',
      label: 'Signal',
      sort: (r) => (r.signal === 'strong-buy' ? 2 : r.signal === 'neutral' ? 1 : 0),
      cell: (r) => (
        <span
          className={
            r.signal === 'strong-buy'
              ? 'up scan-strong'
              : r.signal === 'strong-sell'
                ? 'down scan-strong'
                : 'muted'
          }
        >
          {SIGNAL_LABEL[r.signal]}
        </span>
      ),
      align: 'left',
    },
  ];

  return (
    <ScannerFrame
      testId="market-pressure"
      subtitle={tl('aggressor buy %')}
      chips={WINDOWS.map((w) => (
        <Chip
          key={w.id}
          selected={win === w.id}
          onClick={() => setParams({ window: w.id, sortKey: w.id, sortDir: 'desc' })}
        >
          {w.label}
        </Chip>
      ))}
      settings={
        <CommonSettings
          ids={ids}
          alerts={alerts}
          onIds={(v) => setParams({ ids: v })}
          onAlerts={(v) => setParams({ alerts: v })}
          onReset={() =>
            setParams({ ids: undefined, thresholds: undefined, alerts: false, window: 'm5' })
          }
        >
          <label>
            {tl('Strong buy at ≥ (%)')}
            <Input
              type="number"
              min={0}
              max={100}
              value={th.strongBuy}
              onChange={(e) =>
                setParams({ thresholds: { ...th, strongBuy: Number(e.target.value) } })
              }
            />
          </label>
          <label>
            {tl('Strong sell at ≤ (%)')}
            <Input
              type="number"
              min={0}
              max={100}
              value={th.strongSell}
              onChange={(e) =>
                setParams({ thresholds: { ...th, strongSell: Number(e.target.value) } })
              }
            />
          </label>
        </CommonSettings>
      }
      footer={`Buy % = aggressive buy volume ÷ aggressor volume · signal on the ${WINDOWS.find((w) => w.id === win)!.label} window: strong buy ≥ ${th.strongBuy}%, strong sell ≤ ${th.strongSell}% · click a row to open its chart`}
    >
      <ScannerTable
        rows={rows}
        columns={columns}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onSort={(sortKey, sortDir) => setParams({ sortKey, sortDir })}
        onRowClick={(r) => openOnChart(r.key)}
        empty={ids.length ? 'Loading instruments…' : 'No instruments selected (⚙)'}
      />
    </ScannerFrame>
  );
}

registerModule({ id: 'market-pressure', view: MarketPressure });
