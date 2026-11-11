import { useEffect, useState } from 'react';
import { Badge, StatusPill } from '@htflow/ui-kit';
import { hub } from '../../state/market';
import { isTauri } from '../../backend';
import { SimpleTable } from '../../components/SimpleTable';
import { registerModule } from '../registry';

function useTicker(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
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
      <SimpleTable
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

registerModule({
  id: 'connections',
  view: function ConnectionsWindow() {
    return (
      <div className="module-window">
        <Connections />
      </div>
    );
  },
});
