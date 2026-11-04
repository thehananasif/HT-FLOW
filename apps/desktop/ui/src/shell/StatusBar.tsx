import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { StatusPill } from '@htflow/ui-kit';
import type { MarketStore } from '@htflow/market-data';
import { hub } from '../state/market';
import { runCommand } from './commands';

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
    state: st === 'live' && inst.id.startsWith('mock:') ? 'live' : st,
    title: `${venue}: ${st}${s.status.message ? ' — ' + s.status.message : ''} · ${s.status.latencyMs.toFixed(0)} ms · ${s.status.msgsPerSec.toFixed(0)} msg/s`,
  };
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
  let clock = '';
  try {
    clock = new Date().toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false });
  } catch {
    clock = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }
  return (
    <footer className="statusbar">
      <StatusPill state="live" label="Local core" title="All data stays on this PC" />
      {[...pills.values()].map((p) => (
        <StatusPill
          key={p.key}
          state={p.state}
          label={p.label}
          title={p.title}
          onClick={() => runCommand('open.connections')}
        />
      ))}
      <button
        className="ht-icon-btn"
        aria-label="Connections"
        onClick={() => runCommand('open.connections')}
      >
        <Settings size={13} />
      </button>
      <div className="grow" />
      <span className="sb-item tnum">Latency {latency.toFixed(0)} ms</span>
      {mem && (
        <span className="sb-item tnum">RAM {(mem.usedJSHeapSize / 1048576).toFixed(0)} MB</span>
      )}
      <span className="sb-item tnum" title={timezone}>
        {clock} {timezone.split('/').pop()?.replace('_', ' ')}
      </span>
      <span className="sb-item sb-version">v{version}</span>
    </footer>
  );
}
