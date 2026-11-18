import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { StatusPill } from '@htflow/ui-kit';
import type { MarketStore } from '@htflow/market-data';
import { hub, paper } from '../state/market';
import { activeInstrument } from '../state/windows';
import { routedAccount } from '../trading/accounts';
import { startOfLocalDay } from '../trading/TradingPanel';
import { HIDDEN_MONEY, usePrivacy } from '../state/format';
import { runCommand } from './commands';
import { classifyDelay, useSetting } from '../state/settings';

import { translateLiteral as tl } from '@htflow/i18n';
/** Settings → Data delays: amber above the warning latency, red above the critical one. */
const DELAY_STATE = { ok: 'live', warning: 'delayed', critical: 'error' } as const;

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function feedLabel(s: MarketStore): { key: string; label: string; state: string; title: string } {
  const inst = s.instrument;
  const venue = inst.id.startsWith('mock:')
    ? inst.assetClass === 'crypto'
      ? 'Crypto Sim'
      : 'HT Sim'
    : inst.exchange;
  const st = s.status.state;
  return {
    key: venue,
    label: venue,
    state: st === 'live' ? DELAY_STATE[classifyDelay(s.status.latencyMs)] : st,
    title: `${venue}: ${st}${s.status.message ? ' — ' + s.status.message : ''} · ${s.status.latencyMs.toFixed(0)} ms · ${s.status.msgsPerSec.toFixed(0)} msg/s`,
  };
}

/** Paper account P&L: open P&L at the marks and today's net (realized − fees + open). */
function PnlItem() {
  const privacy = usePrivacy();
  const acc = routedAccount(activeInstrument());
  const s = paper.pnlSummary(acc.id, startOfLocalDay());
  const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const f = (v: number) =>
    privacy.hide ? HIDDEN_MONEY : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
  return (
    <button
      className="sb-item sb-pnl tnum"
      data-testid="status-pnl"
      title={`${acc.name}: open P&L of every position, and today's net (realized ${s.realized.toFixed(2)} − fees ${s.fees.toFixed(2)} + open). Click for positions.`}
      onClick={() => runCommand('open.positions')}
    >
      P&amp;L{' '}
      <b className={cls(s.open)} data-testid="status-pnl-open">
        {f(s.open)}
      </b>
      <span className="muted"> {tl('· Day')} </span>
      <b className={cls(s.net)}>{f(s.net)}</b>
    </button>
  );
}

/** Bottom status bar: one pill per connection, latency, memory, clock, version. */
export function StatusBar({ version, timezone }: { version: string; timezone: string }) {
  useTick(1000);
  const pills = new Map<string, ReturnType<typeof feedLabel>>();
  for (const s of hub.stores()) {
    const f = feedLabel(s);
    if (!pills.has(f.key)) pills.set(f.key, f);
  }
  const latency = Math.max(0, ...hub.stores().map((s) => s.status.latencyMs));
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  useSetting('dataDelays.warningMs');
  useSetting('dataDelays.criticalMs');
  const hour12 = !useSetting('general.clock24h');
  const appZone = useSetting('timezones.app');
  if (appZone) timezone = appZone;
  let clock = '';
  try {
    clock = new Date().toLocaleTimeString('en-GB', { timeZone: timezone, hour12 });
  } catch {
    clock = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }
  return (
    <footer className="statusbar">
      <StatusPill state="live" label={tl('Local core')} title={tl('All data stays on this PC')} />
      {[...pills.values()].map((p) => (
        <StatusPill
          key={p.key}
          state={p.state}
          label={tl(p.label)}
          title={tl(p.title)}
          onClick={() => runCommand('open.connections')}
        />
      ))}
      <button
        className="ht-icon-btn"
        aria-label={tl('Connections')}
        onClick={() => runCommand('open.connections')}
      >
        <Settings size={13} />
      </button>
      <div className="grow" />
      <PnlItem />
      <span className="sb-item tnum">
        {tl('Latency')} {latency.toFixed(0)} {tl('ms')}
      </span>
      {mem && (
        <span className="sb-item tnum">
          {tl('RAM')} {(mem.usedJSHeapSize / 1048576).toFixed(0)} {tl('MB')}
        </span>
      )}
      <span className="sb-item tnum" title={timezone}>
        {clock} {timezone.split('/').pop()?.replace('_', ' ')}
      </span>
      <span className="sb-item sb-version">v{version}</span>
    </footer>
  );
}
