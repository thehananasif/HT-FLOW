import { useEffect, useState, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Badge, Button, EmptyState, StatusPill } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import { formatPrice } from '@htflow/market-data';
import type { ModuleWindowState } from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { hub, paper, PAPER_ACCOUNT } from '../state/market';
import { instrumentById } from '../state/instruments';
import { moduleDef } from '../shell/modules';
import { MODULE_ICONS } from '../shell/icons';
import { isTauri } from '../backend';

function useTicker(ms = 500) {
  const [, set] = useState(0);
  useEffect(() => {
    const u = paper.subscribe(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => {
      u();
      clearInterval(i);
    };
  }, [ms]);
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl tnum">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, k) => (
                <td key={k}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="tbl-empty">{empty}</div>}
    </div>
  );
}

const px = (instrumentId: string, v: number | undefined) => {
  const i = instrumentById(instrumentId);
  return v === undefined || !i ? '—' : formatPrice(v, i);
};
const sym = (id: string) => instrumentById(id)?.symbol ?? id;
const time = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour12: false }) +
  '.' +
  String(Math.floor(t % 1000)).padStart(3, '0');
const sidePill = (s: string) => (
  <span className={s === 'buy' ? 'up' : 'down'}>{s.toUpperCase()}</span>
);

function Accounts() {
  useTicker();
  const rows = [...paper.accounts.values()].map((a) => {
    let open = 0;
    for (const p of paper.allPositions(a.id)) {
      const m = hub.peek(p.instrumentId)?.lastTrade?.px;
      if (m !== undefined) open += paper.unrealized(a.id, p.instrumentId, m);
    }
    return [
      a.name,
      'HT Sim (paper)',
      a.balance.toFixed(2),
      (a.balance + open).toFixed(2),
      <span className={open >= 0 ? 'up' : 'down'}>{open.toFixed(2)}</span>,
      <span className={a.balance - a.startingBalance >= 0 ? 'up' : 'down'}>
        {(a.balance - a.startingBalance).toFixed(2)}
      </span>,
      a.locked ? <Badge kind="error">Locked</Badge> : <Badge kind="live">OK</Badge>,
    ];
  });
  return (
    <Table
      head={['Account', 'Connection', 'Balance', 'Equity', 'Open P&L', 'Day P&L', 'Risk']}
      rows={rows}
      empty="No accounts"
    />
  );
}

function Positions() {
  useTicker();
  const rows = paper.allPositions(PAPER_ACCOUNT).map((p) => {
    const m = hub.peek(p.instrumentId)?.lastTrade?.px;
    const u = m !== undefined ? paper.unrealized(PAPER_ACCOUNT, p.instrumentId, m) : 0;
    return [
      sym(p.instrumentId),
      'Paper',
      sidePill(p.qty > 0 ? 'buy' : 'sell'),
      Math.abs(p.qty),
      px(p.instrumentId, p.avgPx),
      px(p.instrumentId, m),
      <span className={u >= 0 ? 'up' : 'down'}>{u.toFixed(2)}</span>,
      <span className="row gap6">
        <Button size="xs" onClick={() => paper.flatten(PAPER_ACCOUNT, p.instrumentId)}>
          Close
        </Button>
        <Button size="xs" onClick={() => paper.reverse(PAPER_ACCOUNT, p.instrumentId)}>
          Reverse
        </Button>
      </span>,
    ];
  });
  return (
    <div className="col fill">
      <Table
        head={['Instrument', 'Account', 'Side', 'Qty', 'Avg price', 'Mark', 'Open P&L', '']}
        rows={rows}
        empty="No open positions"
      />
      <div className="tbl-foot">
        <Button size="sm" onClick={() => paper.flattenAll(PAPER_ACCOUNT)}>
          Flatten all
        </Button>
      </div>
    </div>
  );
}

function Orders() {
  useTicker();
  const rows = [...paper.orders.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 300)
    .map((o) => [
      time(o.createdAt),
      sym(o.instrumentId),
      sidePill(o.side),
      `${o.type}${o.role && o.role !== 'entry' ? ` (${o.role.toUpperCase()})` : ''}`,
      `${o.filled}/${o.qty}`,
      px(o.instrumentId, o.px ?? o.stopPx),
      o.tif,
      <Badge
        kind={
          o.status === 'filled'
            ? 'live'
            : o.status === 'rejected'
              ? 'error'
              : o.status === 'cancelled'
                ? 'default'
                : 'delayed'
        }
      >
        {o.status}
        {o.reason ? `: ${o.reason}` : ''}
      </Badge>,
      o.status === 'working' || o.status === 'partial' ? (
        <Button size="xs" onClick={() => paper.cancel(o.id)}>
          ×
        </Button>
      ) : null,
    ]);
  return (
    <div className="col fill">
      <Table
        head={['Time', 'Instrument', 'Side', 'Type', 'Filled', 'Price', 'TIF', 'Status', '']}
        rows={rows}
        empty="No orders yet"
      />
      <div className="tbl-foot">
        <Button size="sm" onClick={() => paper.cancelAll(PAPER_ACCOUNT)}>
          Cancel all
        </Button>
      </div>
    </div>
  );
}

function Trades() {
  useTicker();
  const rows = [...paper.fills]
    .reverse()
    .slice(0, 500)
    .map((f) => [
      time(f.ts),
      sym(f.instrumentId),
      sidePill(f.side),
      f.qty,
      px(f.instrumentId, f.px),
      f.commission.toFixed(2),
      f.realized.toFixed(2),
      f.liquidity,
    ]);
  return (
    <Table
      head={[
        'Time',
        'Instrument',
        'Side',
        'Qty',
        'Price',
        'Commission',
        'Realized P&L',
        'Liquidity',
      ]}
      rows={rows}
      empty="No fills yet"
    />
  );
}

const PROVIDERS: { group: string; items: [string, 'FREE' | 'YOUR ACCOUNT', string][] }[] = [
  {
    group: 'Crypto',
    items: [
      [
        'Binance Futures',
        'FREE',
        isTauri ? 'Built in — open BTCUSDT from the instrument picker' : 'Desktop app only',
      ],
      ['Binance', 'FREE', 'P05'],
      ['Bybit', 'FREE', 'P05'],
      ['OKX', 'FREE', 'P05'],
      ['Bitget', 'FREE', 'P05'],
      ['Kraken', 'FREE', 'P05'],
      ['Bitfinex', 'FREE', 'P05'],
      ['Phemex', 'FREE', 'P05'],
      ['WhiteBIT', 'FREE', 'P05'],
      ['Deribit', 'FREE', 'P05 / P18'],
    ],
  },
  {
    group: 'Simulator',
    items: [
      ['HT Sim (MockFeed)', 'FREE', 'Built in'],
      ['Crypto Sim', 'FREE', 'Built in'],
    ],
  },
  {
    group: 'US and EU markets',
    items: [
      ['Rithmic', 'YOUR ACCOUNT', 'P05 — requires R|Protocol credentials'],
      ['CQG', 'YOUR ACCOUNT', 'P05'],
      ['dxFeed', 'YOUR ACCOUNT', 'P05'],
      ['Interactive Brokers', 'YOUR ACCOUNT', 'P05'],
      ['Tradovate', 'YOUR ACCOUNT', 'P05'],
      ['Alpaca (IEX)', 'YOUR ACCOUNT', 'P05'],
    ],
  },
];

function Connections() {
  useTicker(1000);
  const stores = hub.stores();
  return (
    <div className="col fill pad12 gap12">
      <div className="row gap8">
        <div className="card-stat">
          <span className="muted">Live connections</span>
          <b>{stores.filter((s) => s.status.state === 'live').length}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Instruments streaming</span>
          <b>{stores.length}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Avg latency</span>
          <b className="tnum">
            {(
              stores.reduce((a, s) => a + s.status.latencyMs, 0) / Math.max(1, stores.length)
            ).toFixed(0)}{' '}
            ms
          </b>
        </div>
      </div>
      <Table
        head={['Connection', 'Instrument', 'Status', 'Latency', 'Msgs/s', 'Ticks']}
        rows={stores.map((s) => [
          s.instrument.id.startsWith('mock:')
            ? s.instrument.assetClass === 'crypto'
              ? 'Crypto Sim'
              : 'HT Sim'
            : s.instrument.exchange,
          s.instrument.symbol,
          <StatusPill
            state={s.status.state}
            label={s.status.message ? `${s.status.state}: ${s.status.message}` : s.status.state}
          />,
          `${s.status.latencyMs.toFixed(0)} ms`,
          s.status.msgsPerSec.toFixed(0),
          s.trades.length.toLocaleString(),
        ])}
        empty="Open a chart to connect"
      />
      <h4 className="section-title">Providers</h4>
      {PROVIDERS.map((g) => (
        <div key={g.group}>
          <div className="ht-menu-label">{g.group}</div>
          {g.items.map(([name, tag, note]) => (
            <div key={name} className="provider-row">
              <span>{name}</span>
              <Badge kind={tag === 'FREE' ? 'free' : 'default'}>{tag}</Badge>
              <span className="muted grow">{note}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const BUILT: Record<string, () => ReactNode> = {
  accounts: () => <Accounts />,
  positions: () => <Positions />,
  orders: () => <Orders />,
  trades: () => <Trades />,
  connections: () => <Connections />,
};

export function ModuleWindow(props: IDockviewPanelProps) {
  const s = useWindows((st) => st.windows[props.api.id]) as ModuleWindowState | undefined;
  if (!s) return null;
  const built = BUILT[s.module];
  if (built) return <div className="module-window">{built()}</div>;
  const def = moduleDef(s.module);
  const Icon = MODULE_ICONS[s.module] ?? MODULE_ICONS.chart!;
  return (
    <EmptyState
      icon={<Icon size={28} />}
      title={t('empty.module.title', { name: def?.label ?? s.module })}
    >
      {t('empty.module.body', { phase: def?.phase ?? '—' })}
    </EmptyState>
  );
}
