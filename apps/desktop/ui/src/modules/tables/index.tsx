import { useEffect, useState } from 'react';
import { Badge, Button } from '@htflow/ui-kit';
import { formatPrice } from '@htflow/market-data';
import { hub, paper, PAPER_ACCOUNT } from '../../state/market';
import { instrumentById } from '../../state/instruments';
import { SimpleTable } from '../../components/SimpleTable';
import { registerModule } from '../registry';

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
    <SimpleTable
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
      <SimpleTable
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
      <SimpleTable
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
    <SimpleTable
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

const wrap = (C: () => JSX.Element) =>
  function ModuleTable() {
    return (
      <div className="module-window">
        <C />
      </div>
    );
  };

registerModule({ id: 'accounts', view: wrap(Accounts) });
registerModule({ id: 'positions', view: wrap(Positions) });
registerModule({ id: 'orders', view: wrap(Orders) });
registerModule({ id: 'trades', view: wrap(Trades) });
