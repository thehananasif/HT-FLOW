import { useEffect, useState } from 'react';
import { Button, Checkbox, SegmentedControl } from '@htflow/ui-kit';
import { hub } from '../../state/market';
import { isTauri } from '../../backend';
import { isVenueEnabled, setVenueEnabled, venueStats } from '../../state/liveFeed';
import { registerModule } from '../registry';
import { DataManager } from '../data-manager/view';
import { ConnectionWizard } from './Wizard';
import { useConnections, venueOf } from './store';
import { latencyLevel, providerById, type ConnectionConfig, type LatencyLevel } from './providers';
import './styles.css';

function useTicker(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}

type RowStatus = 'connected' | 'disconnected' | 'delayed' | 'connecting' | 'error';

interface Row {
  c: ConnectionConfig;
  subtitle: string;
  type: string;
  status: RowStatus;
  label: string;
  latency: number | null;
  latencyText: string;
  msgs: number | null;
  accounts: string;
  resyncs: number;
  canToggle: boolean;
  connected: boolean;
}

function rowFor(c: ConnectionConfig): Row {
  const p = providerById(c.provider)!;
  const venue = venueOf(c);
  const type =
    p.group === 'Crypto' ? 'Crypto' : p.group === 'Simulator' ? 'Simulator' : 'Futures broker';
  const base = {
    c,
    type,
    resyncs: 0,
    accounts: '—',
    latency: null,
    latencyText: '—',
    msgs: null,
  };
  if (p.blocked) {
    return {
      ...base,
      subtitle: c.server || p.blurb.split('.')[0]!,
      status: 'error',
      label: 'Error: requires SDK',
      canToggle: false,
      connected: false,
    };
  }
  if (p.simulator) {
    const stores = hub
      .stores()
      .filter(
        (s) =>
          s.instrument.id.startsWith('mock:') &&
          (p.simulator === 'crypto') === (s.instrument.assetClass === 'crypto'),
      );
    const msgs = stores.reduce((a, s) => a + s.status.msgsPerSec, 0);
    return {
      ...base,
      subtitle: p.simulator === 'crypto' ? 'Simulated crypto' : 'CME delayed demo',
      status: p.id === 'ht-sim' ? 'delayed' : 'connected',
      label: 'Connected',
      latencyText: p.id === 'ht-sim' ? 'delayed' : '0 ms',
      msgs,
      accounts: c.trading ? '1 paper' : '—',
      canToggle: false,
      connected: true,
    };
  }
  const v = venue!;
  const st = venueStats(v);
  const enabled = isVenueEnabled(v);
  let status: RowStatus;
  let label: string;
  if (!isTauri) {
    status = 'disconnected';
    label = 'Desktop app only';
  } else if (!enabled) {
    status = 'disconnected';
    label = 'Disconnected';
  } else if (st.state === 'idle') {
    status = 'connected';
    label = 'Connected · idle';
  } else if (st.state === 'live') {
    status = 'connected';
    label = 'Connected';
  } else if (st.state === 'error' || st.state === 'disconnected') {
    status = 'error';
    label = `Error: ${st.message ?? st.state}`;
  } else {
    status = 'connecting';
    label = 'Connecting…';
  }
  const live = enabled && st.feeds > 0;
  return {
    ...base,
    subtitle: `${v === 'binance-futures' ? 'USDⓈ-M' : 'Linear perps'} · ${st.feeds} streaming${st.recording ? ` · ${st.recording} recording` : ''}`,
    status,
    label,
    latency: live ? st.latencyMs : null,
    latencyText: live ? `${st.latencyMs.toFixed(0)} ms` : '—',
    msgs: live ? st.msgsPerSec : null,
    resyncs: st.resyncs,
    accounts: c.trading && c.hasSecret ? '1' : '0',
    canToggle: isTauri,
    connected: enabled,
  };
}

const LAT_CLASS: Record<LatencyLevel, string> = { ok: 'up', warn: 'warn', bad: 'down', none: '' };

function Connections({ onData }: { onData: () => void }) {
  useTicker(1000);
  const { list, autoConnect, setAutoConnect, loaded, load, remove } = useConnections();
  const [wizard, setWizard] = useState<{ edit?: ConnectionConfig } | null>(null);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  const rows = list.filter((c) => providerById(c.provider)).map(rowFor);
  const live = rows.filter((r) => r.status === 'connected' || r.status === 'delayed').length;
  const lat = rows.filter((r) => r.latency !== null);
  const avg = lat.length ? lat.reduce((a, r) => a + r.latency!, 0) / lat.length : null;
  const msgs = rows.reduce((a, r) => a + (r.msgs ?? 0), 0);
  const gaps = rows.reduce((a, r) => a + r.resyncs, 0);
  const toggleAll = (on: boolean) => {
    for (const r of rows) {
      const v = venueOf(r.c);
      if (v && r.canToggle) setVenueEnabled(v, on);
    }
  };
  return (
    <div className="col fill pad12 gap12 cx-root">
      <div className="row gap8 cx-toolbar">
        <Button variant="primary" onClick={() => setWizard({})}>
          + Add connection
        </Button>
        <Button variant="outline" onClick={() => toggleAll(true)}>
          Connect all
        </Button>
        <Button variant="outline" onClick={() => toggleAll(false)}>
          Disconnect all
        </Button>
        <Button variant="ghost" onClick={onData}>
          Data manager
        </Button>
        <div className="grow" />
        <Checkbox label="Auto-connect on start" checked={autoConnect} onChange={setAutoConnect} />
      </div>
      <div className="tbl-wrap">
        <table className="tbl tnum cx-table">
          <thead>
            <tr>
              <th>Connection</th>
              <th>Type</th>
              <th>Status</th>
              <th className="r">Latency</th>
              <th className="r">Msgs/s</th>
              <th className="r">Accounts</th>
              <th className="r">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.c.id}>
                <td>
                  <div className="cx-name">
                    <span className="cx-avatar sm">{r.c.name[0]}</span>
                    <div>
                      <b>{r.c.name}</b>
                      <div className="muted cx-sub">{r.subtitle}</div>
                    </div>
                  </div>
                </td>
                <td>{r.type}</td>
                <td>
                  <span className={`cx-status cx-status--${r.status}`} title={r.label}>
                    <i />
                    {r.label}
                  </span>
                </td>
                <td className={`r ${LAT_CLASS[latencyLevel(r.latency)]}`}>{r.latencyText}</td>
                <td className="r">{r.msgs === null ? '—' : r.msgs.toLocaleString()}</td>
                <td className="r">{r.accounts}</td>
                <td className="r">
                  <div className="cx-actions-cell">
                    {r.canToggle ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setVenueEnabled(venueOf(r.c)!, !r.connected)}
                      >
                        {r.connected ? 'Disconnect' : 'Connect'}
                      </Button>
                    ) : r.status === 'error' ? (
                      <Button size="sm" variant="outline" onClick={() => setWizard({ edit: r.c })}>
                        Retry
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      className="cx-link"
                      onClick={() => setWizard({ edit: r.c })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="cx-link"
                      aria-label={`Remove ${r.c.name}`}
                      onClick={() => remove(r.c.id)}
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="tbl-empty">No connections — add one</div>}
      </div>
      <div className="cx-cards">
        <div className="card-stat">
          <span className="muted">Live connections</span>
          <b>
            {live} / {rows.length}
          </b>
        </div>
        <div className="card-stat">
          <span className="muted">Avg latency</span>
          <b className={`tnum ${LAT_CLASS[latencyLevel(avg)]}`}>
            {avg === null ? '—' : `${avg.toFixed(0)} ms`}
          </b>
        </div>
        <div className="card-stat">
          <span className="muted">Messages / sec</span>
          <b className="tnum">{msgs.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Gaps resynced today</span>
          <b className="tnum">{gaps}</b>
        </div>
      </div>
      {wizard && <ConnectionWizard open edit={wizard.edit} onClose={() => setWizard(null)} />}
    </div>
  );
}

registerModule({
  id: 'connections',
  view: function ConnectionsWindow({ state, setParams }) {
    const tab = state.params?.tab === 'data' ? 'data' : 'connections';
    return (
      <div className="module-window col">
        <div className="cx-tabs">
          <SegmentedControl
            value={tab}
            options={[
              { value: 'connections', label: 'Connections' },
              { value: 'data', label: 'Data manager' },
            ]}
            onChange={(v) => setParams({ tab: v })}
          />
        </div>
        {tab === 'data' ? (
          <DataManager />
        ) : (
          <Connections onData={() => setParams({ tab: 'data' })} />
        )}
      </div>
    );
  },
});
