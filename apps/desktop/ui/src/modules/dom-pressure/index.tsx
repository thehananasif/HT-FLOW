import { useEffect, useRef } from 'react';
import { Chip, Input, theme, toast } from '@htflow/ui-kit';
import { formatQty } from '@htflow/market-data';
import { DOM_BANDS, type DomBand, type DomPressureReading } from '@htflow/analytics';
import { registerModule, type ModuleViewProps } from '../registry';
import { beep, num } from '../smart-tape/shared';
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
interface Row {
  key: string;
  sym: string;
  qp: number;
  r: DomPressureReading;
  pull: boolean;
}

function DomPressure({ state, setParams }: ModuleViewProps) {
  const raw = state.params ?? {};
  const ids = scannerIds(raw.ids);
  const band: DomBand = (DOM_BANDS as readonly number[]).includes(raw.band as number)
    ? (raw.band as DomBand)
    : 10;
  const alerts = raw.alerts === true;
  const pullPct = num(raw.pullPct, 30, 5, 95);
  const tintPct = num(raw.tintPct, 40, 5, 100);
  const sort = sortParams(raw, 'imb');
  const list = useAnalytics(ids);
  const rows: Row[] = list.flatMap((a) => {
    a.dom.pullPct = pullPct;
    const r = a.domReading(band);
    return r
      ? [
          {
            key: a.instrument.id,
            sym: a.instrument.symbol,
            qp: a.instrument.qtyPrecision,
            r,
            pull: r.pullBid || r.pullAsk,
          },
        ]
      : [];
  });

  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const r of rows) {
      if (r.pull && alerts && !seen.current.has(r.key)) {
        toast(
          'warning',
          tt`${r.sym}: liquidity pulled`,
          tt`${r.r.pullBid ? 'Bid' : 'Ask'} side lost > ${pullPct}% within ±${band} ticks`,
        );
        beep(r.r.pullBid ? -1 : 1);
      }
      if (r.pull) seen.current.add(r.key);
      else seen.current.delete(r.key);
    }
  });

  const t = theme();
  const columns: ScanColumn<Row>[] = [
    {
      id: 'sym',
      label: 'Symbol',
      sort: (r) => r.sym,
      cell: (r) => <span className="scan-sym">{r.sym}</span>,
      align: 'left',
    },
    {
      id: 'bid',
      label: 'Bid size',
      sort: (r) => r.r.bid,
      cell: (r) => <span className="up">{formatQty(r.r.bid, r.qp)}</span>,
    },
    {
      id: 'ask',
      label: 'Ask size',
      sort: (r) => r.r.ask,
      cell: (r) => <span className="down">{formatQty(r.r.ask, r.qp)}</span>,
    },
    {
      id: 'bar',
      label: 'Imbalance',
      sort: (r) => r.r.imbalance,
      cell: (r) => {
        const v = r.r.imbalance;
        const w = Math.abs(v) / 2;
        return (
          <span className="scan-imb">
            <i
              style={{
                left: v >= 0 ? '50%' : `${50 - w}%`,
                width: `${w}%`,
                background: v >= 0 ? t.up : t.down,
              }}
            />
          </span>
        );
      },
      width: '1.4fr',
      align: 'center',
    },
    {
      id: 'imb',
      label: '%',
      sort: (r) => r.r.imbalance,
      cell: (r) => (
        <span className={`scan-strong ${r.r.imbalance >= 0 ? 'up' : 'down'}`}>
          {r.r.imbalance > 0 ? '+' : ''}
          {r.r.imbalance.toFixed(0)}%
        </span>
      ),
      width: '0.7fr',
    },
    {
      id: 'chg',
      label: 'Δ liq/s',
      sort: (r) => r.r.changePerSec,
      cell: (r) => (
        <span
          className="scan-bar"
          style={{
            color: r.r.changePerSec >= 0 ? t.up : t.down,
            background: r.pull ? tint(t.warning, 0.25) : undefined,
          }}
        >
          {r.r.changePerSec > 0 ? '+' : ''}
          {formatQty(r.r.changePerSec, r.qp)}/s
        </span>
      ),
    },
  ];

  return (
    <ScannerFrame
      testId="dom-pressure"
      subtitle={tt`±${band} ticks`}
      chips={DOM_BANDS.map((b) => (
        <Chip key={b} selected={band === b} onClick={() => setParams({ band: b })}>
          {b === 25 ? '25 ticks' : b}
        </Chip>
      ))}
      settings={
        <CommonSettings
          ids={ids}
          alerts={alerts}
          onIds={(v) => setParams({ ids: v })}
          onAlerts={(v) => setParams({ alerts: v })}
          onReset={() =>
            setParams({ ids: undefined, alerts: false, band: 10, pullPct: 30, tintPct: 40 })
          }
        >
          <label>
            {tl('Pull flash when a side drops by more than (%)')}
            <Input
              type="number"
              min={5}
              max={95}
              value={pullPct}
              onChange={(e) => setParams({ pullPct: num(Number(e.target.value), 30, 5, 95) })}
            />
          </label>
          <label>
            {tl('Tint rows when |imbalance| above (%)')}
            <Input
              type="number"
              min={5}
              max={100}
              value={tintPct}
              onChange={(e) => setParams({ tintPct: num(Number(e.target.value), 40, 5, 100) })}
            />
          </label>
        </CommonSettings>
      }
      footer={`Resting liquidity within ${band} ticks of best bid / ask · imbalance = (bid − ask) ÷ (bid + ask) · row tint when |imbalance| > ${tintPct}% · flashes on pulls > ${pullPct}% · click a row to open its chart`}
    >
      <ScannerTable
        rows={rows}
        columns={columns}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onSort={(sortKey, sortDir) => setParams({ sortKey, sortDir })}
        onRowClick={(r) => openOnChart(r.key)}
        rowProps={(r) => ({
          'data-tint':
            Math.abs(r.r.imbalance) > tintPct ? (r.r.imbalance > 0 ? 'up' : 'down') : undefined,
          'data-flash': r.pull || undefined,
        })}
        empty={ids.length ? 'Loading order books…' : 'No instruments selected (⚙)'}
      />
    </ScannerFrame>
  );
}

registerModule({ id: 'dom-pressure', view: DomPressure });
