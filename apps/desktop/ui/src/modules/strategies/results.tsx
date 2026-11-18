import { formatPrice } from '@htflow/market-data';
import type { BacktestResult, BacktestTrade } from '@htflow/strategy';
import { Table, type TableColumn } from '@htflow/ui-kit';
import { money, pct, ratio, signedMoney, tone } from './shared';

export const fmtTime = (ts: number) => new Date(ts).toISOString().slice(5, 19).replace('T', ' ');

export function Stat({
  label,
  value,
  cls,
  testId,
}: {
  label: string;
  value: string;
  cls?: string;
  testId?: string;
}) {
  return (
    <div className="stg-stat">
      <span>{label}</span>
      <b className={`tnum ${cls ?? ''}`} data-testid={testId}>
        {value}
      </b>
    </div>
  );
}

export function Summary({ r }: { r: BacktestResult }) {
  const s = r.stats;
  const days = Math.max(1, (r.to - r.from) / 86_400_000);
  return (
    <div className="stg-summary" data-testid="strategy-summary">
      <div className="stg-stats">
        <Stat
          label="Net P&L"
          value={signedMoney(s.netPnl, 2)}
          cls={tone(s.netPnl)}
          testId="strategy-net"
        />
        <Stat label="Trades" value={String(s.trades)} testId="strategy-trades-count" />
        <Stat label="Win rate" value={pct(s.winRate)} />
        <Stat label="Profit factor" value={ratio(s.profitFactor)} />
        <Stat label="Expectancy" value={signedMoney(s.expectancy, 2)} cls={tone(s.expectancy)} />
        <Stat
          label="Expectancy (R)"
          value={Number.isNaN(s.expectancyR) ? '—' : `${s.expectancyR.toFixed(2)} R`}
        />
        <Stat
          label="Max drawdown"
          value={money(s.maxDrawdown, 2)}
          cls={s.maxDrawdown > 0 ? 'down' : ''}
        />
        <Stat label="Monte-Carlo DD 95%" value={money(s.monteCarloDd95, 2)} />
        <Stat label="Sharpe / trade" value={ratio(s.sharpe)} />
        <Stat label="Sortino / trade" value={ratio(s.sortino)} />
        <Stat label="Avg win / loss" value={`${money(s.avgWin)} / ${money(s.avgLoss)}`} />
        <Stat label="Commission" value={money(s.commission, 2)} />
        <Stat label="Long / short" value={`${s.longTrades} / ${s.shortTrades}`} />
        <Stat label="Return" value={pct(s.returnPct, 2)} cls={tone(s.returnPct)} />
        <Stat label="Avg bars held" value={s.avgBarsHeld.toFixed(1)} />
        <Stat label="Trades / day" value={(s.trades / days).toFixed(1)} />
      </div>
      <p className="stg-muted tnum">
        {r.config.instrument.symbol} · {fmtTime(r.from)} → {fmtTime(r.to)} UTC ·{' '}
        {r.ticks.toLocaleString()} ticks · {r.barCount} bars · fills:{' '}
        {r.config.fillModel === 'book' ? 'recorded book' : 'tape'} + {r.config.slippageTicks} tick
        slippage · {money(r.config.commissionPerUnit, 2)}/side. Sharpe and Sortino use per-trade net
        P&L (not annualised).
      </p>
    </div>
  );
}

export function TradesTable({ r }: { r: BacktestResult }) {
  const inst = r.config.instrument;
  const px = (v: number) => formatPrice(v, inst);
  const columns: TableColumn<BacktestTrade>[] = [
    { key: 'n', header: '#', width: 40, numeric: true, sortable: true, render: (t) => t.n },
    {
      key: 'side',
      header: 'Side',
      width: 56,
      sortable: true,
      render: (t) => (
        <span className={t.side === 'long' ? 'up' : 'down'}>
          {t.side === 'long' ? 'Long' : 'Short'}
        </span>
      ),
    },
    { key: 'qty', header: 'Qty', width: 44, numeric: true, sortable: true },
    {
      key: 'entryTs',
      header: 'Entry',
      width: 118,
      sortable: true,
      render: (t) => fmtTime(t.entryTs),
    },
    {
      key: 'entryPx',
      header: 'Price',
      width: 80,
      numeric: true,
      sortable: true,
      render: (t) => px(t.entryPx),
    },
    { key: 'exitTs', header: 'Exit', width: 118, sortable: true, render: (t) => fmtTime(t.exitTs) },
    {
      key: 'exitPx',
      header: 'Price',
      width: 80,
      numeric: true,
      sortable: true,
      render: (t) => px(t.exitPx),
    },
    {
      key: 'net',
      header: 'Net',
      width: 84,
      numeric: true,
      sortable: true,
      render: (t) => <span className={tone(t.net)}>{signedMoney(t.net, 2)}</span>,
    },
    {
      key: 'r',
      header: 'R',
      width: 50,
      numeric: true,
      sortable: true,
      sortValue: (t) => t.r ?? -Infinity,
      render: (t) => (t.r === null ? '—' : t.r.toFixed(2)),
    },
    { key: 'maeTicks', header: 'MAE', width: 48, numeric: true, sortable: true },
    { key: 'mfeTicks', header: 'MFE', width: 48, numeric: true, sortable: true },
    { key: 'entryLabel', header: 'Signal', sortable: true },
    {
      key: 'exitReason',
      header: 'Exit',
      width: 70,
      sortable: true,
      render: (t) => t.exitLabel || t.exitReason,
    },
  ];
  return (
    <div className="stg-table" data-testid="strategy-trades">
      <Table
        aria-label="Backtest trades"
        columns={columns}
        rows={r.trades}
        rowId={(t) => String(t.n)}
        empty="No trades"
      />
    </div>
  );
}
