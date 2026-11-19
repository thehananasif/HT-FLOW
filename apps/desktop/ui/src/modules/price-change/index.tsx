import { useEffect, useRef } from 'react';
import { Chip, Input, theme, toast } from '@htflow/ui-kit';
import { moneyChange, type PriceChangeRow } from '@htflow/analytics';
import type { Instrument } from '@htflow/market-data';
import { registerModule, type ModuleViewProps } from '../registry';
import { beep, num, oneOf } from '../smart-tape/shared';
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
} from '../market-pressure/scanner';

import { translateLiteral as tl, tt } from '@htflow/i18n';
type Unit = 'pct' | 'ticks' | 'usd';

interface Row {
  key: string;
  sym: string;
  inst: Instrument;
  c: PriceChangeRow;
  spark: number[];
}

function Spark({ v }: { v: number[] }) {
  const pts = v.filter((x) => !Number.isNaN(x));
  if (pts.length < 2) return <span className="muted">—</span>;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const d = v
    .map((x, i) =>
      Number.isNaN(x)
        ? null
        : `${(i / (v.length - 1)) * 100},${hi > lo ? 17 - ((x - lo) / (hi - lo)) * 16 : 9}`,
    )
    .filter(Boolean)
    .join(' ');
  const up = pts[pts.length - 1]! >= pts[0]!;
  return (
    <svg className="scan-spark" viewBox="0 0 100 18" preserveAspectRatio="none">
      <polyline
        points={d}
        fill="none"
        stroke={up ? theme().up : theme().down}
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PriceChange({ state, setParams }: ModuleViewProps) {
  const raw = state.params ?? {};
  const ids = scannerIds(raw.ids);
  const unit: Unit = oneOf(raw.unit, ['pct', 'ticks', 'usd'] as const, 'pct');
  const alerts = raw.alerts === true;
  const alertPct = num(raw.alertPct, 2, 0.1, 100);
  const sort = sortParams(raw, 'day');
  const list = useAnalytics(ids);
  const rows: Row[] = list.map((a) => ({
    key: a.instrument.id,
    sym: a.instrument.symbol,
    inst: a.instrument,
    c: a.change(),
    spark: a.price.sparkline(a.now, 30, 60_000),
  }));

  const fired = useRef(new Set<string>());
  useEffect(() => {
    for (const r of rows) {
      const over = Math.abs(r.c.pctDay) >= alertPct;
      if (over && !fired.current.has(r.key)) {
        fired.current.add(r.key);
        if (alerts) {
          toast('info', tt`${r.sym} ${r.c.pctDay > 0 ? '+' : ''}${r.c.pctDay.toFixed(2)}% today`);
          beep(r.c.pctDay > 0 ? 1 : -1);
        }
      } else if (!over) fired.current.delete(r.key);
    }
  });

  const fmt = (r: Row, ticks: number, pct: number) => {
    if (Number.isNaN(ticks)) return '—';
    const s = (v: number, d: number) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
    if (unit === 'pct') return `${s(pct, 2)}%`;
    if (unit === 'ticks') return s(ticks, 0);
    return s(moneyChange(ticks, r.inst), 2);
  };
  const t = theme();
  const chg = (
    id: string,
    label: string,
    ticks: (r: Row) => number,
    pct: (r: Row) => number,
    bold = false,
  ): ScanColumn<Row> => ({
    id,
    label,
    sort: (r) => pct(r),
    cell: (r) => {
      const v = pct(r);
      const c = v >= 0 ? t.up : t.down;
      return (
        <span
          className={`scan-bar${bold ? ' scan-strong' : ''}`}
          style={{
            color: Number.isNaN(v) ? undefined : c,
            background: Number.isNaN(v) ? undefined : tint(c, Math.min(1, Math.abs(v) / 3) * 0.3),
          }}
        >
          {fmt(r, ticks(r), v)}
        </span>
      );
    },
  });
  const columns: ScanColumn<Row>[] = [
    {
      id: 'sym',
      label: 'Symbol',
      sort: (r) => r.sym,
      cell: (r) => <span className="scan-sym">{r.sym}</span>,
      align: 'left',
    },
    chg(
      '5m',
      '5m',
      (r) => r.c.ticks5m,
      (r) => r.c.pct5m,
    ),
    chg(
      '1h',
      '1h',
      (r) => r.c.ticks1h,
      (r) => r.c.pct1h,
    ),
    chg(
      'day',
      'Day',
      (r) => r.c.ticksDay,
      (r) => r.c.pctDay,
      true,
    ),
    {
      id: 'range',
      label: 'Day range',
      sort: (r) => r.c.rangePos,
      cell: (r) =>
        Number.isNaN(r.c.rangePos) ? (
          <span className="muted">—</span>
        ) : (
          <span
            className="scan-range"
            title={tt`Position in session range: ${(r.c.rangePos * 100).toFixed(0)}%`}
          >
            <i style={{ left: `${r.c.rangePos * 100}%` }} />
          </span>
        ),
      width: '1.1fr',
    },
    chg(
      'vwap',
      'vs VWAP',
      (r) => r.c.vsVwapTicks,
      (r) => r.c.vsVwapPct,
    ),
    {
      id: 'spark',
      label: '30m',
      sort: (r) => r.c.pct5m,
      cell: (r) => <Spark v={r.spark} />,
      width: '1fr',
    },
  ];

  return (
    <ScannerFrame
      testId="price-change"
      subtitle={tl('multi-window')}
      chips={(
        [
          ['pct', '%'],
          ['ticks', 'Ticks'],
          ['usd', '$'],
        ] as const
      ).map(([id, label]) => (
        <Chip key={id} selected={unit === id} onClick={() => setParams({ unit: id })}>
          {label}
        </Chip>
      ))}
      settings={
        <CommonSettings
          ids={ids}
          alerts={alerts}
          onIds={(v) => setParams({ ids: v })}
          onAlerts={(v) => setParams({ alerts: v })}
          onReset={() => setParams({ ids: undefined, alerts: false, alertPct: 2, unit: 'pct' })}
        >
          <label>
            {tl('Alert when |day change| ≥ (%)')}
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={alertPct}
              onChange={(e) => setParams({ alertPct: num(Number(e.target.value), 2, 0.1, 100) })}
            />
          </label>
        </CommonSettings>
      }
      footer="Day = since session open (00:00 UTC) · day range marker = where price sits between session low and high · $ = per contract (tick value) or price units · click a row to open its chart"
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

registerModule({ id: 'price-change', view: PriceChange });
