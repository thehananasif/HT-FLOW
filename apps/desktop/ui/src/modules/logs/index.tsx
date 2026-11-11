import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button, Checkbox, Input, Select, toast } from '@htflow/ui-kit';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  entriesToText,
  filterEntries,
  formatTime,
  installLogCapture,
  log,
  LOG_LEVELS,
  logBuffer,
  type LogEntry,
  type LogLevel,
} from '../../state/log';
import './styles.css';

installLogCapture();

interface Prefs {
  minLevel: LogLevel;
  source: string;
  query: string;
  paused: boolean;
  fontSize: number;
  wrap: boolean;
  showSource: boolean;
  autoscroll: boolean;
}

const DEFAULTS: Prefs = {
  minLevel: 'debug',
  source: '',
  query: '',
  paused: false,
  fontSize: 11,
  wrap: false,
  showSource: true,
  autoscroll: true,
};

function readPrefs(p: Record<string, unknown> | undefined): Prefs {
  const v = (p?.prefs ?? {}) as Partial<Prefs>;
  const size = Number(v.fontSize);
  return {
    minLevel: LOG_LEVELS.includes(v.minLevel as LogLevel) ? (v.minLevel as LogLevel) : 'debug',
    source: typeof v.source === 'string' ? v.source : '',
    query: typeof v.query === 'string' ? v.query : '',
    paused: v.paused === true,
    fontSize: Number.isFinite(size) ? Math.min(18, Math.max(9, size)) : DEFAULTS.fontSize,
    wrap: v.wrap === true,
    showSource: v.showSource !== false,
    autoscroll: v.autoscroll !== false,
  };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function LogsWindow({ state, setParams }: ModuleViewProps) {
  const prefs = readPrefs(state.params);
  const set = (patch: Partial<Prefs>) => setParams({ prefs: { ...prefs, ...patch } });
  const live = useSyncExternalStore(
    (fn) => logBuffer.subscribe(fn),
    () => logBuffer.snapshot(),
  );
  // Pause freezes the view; the buffer keeps recording.
  const frozen = useRef<LogEntry[] | null>(null);
  if (prefs.paused) frozen.current ??= live;
  else frozen.current = null;
  const entries = prefs.paused ? frozen.current! : live;
  const missed = live.length === 0 ? 0 : live[live.length - 1]!.id - (entries.at(-1)?.id ?? 0);

  const shown = useMemo(
    () =>
      filterEntries(entries, {
        minLevel: prefs.minLevel,
        source: prefs.source,
        query: prefs.query,
      }),
    [entries, prefs.minLevel, prefs.source, prefs.query],
  );
  const sources = useMemo(() => [...new Set(live.map((e) => e.source))].sort(), [live]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && prefs.autoscroll && !prefs.paused) el.scrollTop = el.scrollHeight;
  }, [shown, prefs.autoscroll, prefs.paused]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entriesToText(shown));
      toast('success', 'Copied', `${shown.length} log lines`);
    } catch {
      toast('error', 'Copy failed', 'Clipboard access was denied');
    }
  };

  return (
    <div className="logs-win col" data-testid="logs-window">
      <div className="logs-toolbar">
        <Select<LogLevel>
          aria-label="Minimum level"
          value={prefs.minLevel}
          onChange={(v) => set({ minLevel: v })}
          options={LOG_LEVELS.map((l) => ({ value: l, label: `≥ ${l}` }))}
        />
        <Select<string>
          aria-label="Source"
          value={prefs.source}
          onChange={(v) => set({ source: v })}
          options={[
            { value: '', label: 'All sources' },
            ...sources.map((s) => ({ value: s, label: s })),
          ]}
        />
        <Input
          aria-label="Search logs"
          placeholder="Search…"
          value={prefs.query}
          onChange={(e) => set({ query: e.target.value })}
          style={{ width: 160 }}
        />
        <Button
          size="sm"
          variant={prefs.paused ? 'primary' : 'secondary'}
          onClick={() => set({ paused: !prefs.paused })}
        >
          {prefs.paused ? `Resume${missed ? ` (+${missed})` : ''}` : 'Pause'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          Copy
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            download(
              `htflow-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
              entriesToText(shown),
            )
          }
        >
          Export .txt
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            logBuffer.clear();
            frozen.current = null;
          }}
        >
          Clear
        </Button>
        <span className="grow" />
        <span className="muted tnum" data-testid="logs-count">
          {shown.length} / {live.length}
        </span>
      </div>
      <div className="logs-toolbar logs-view-opts">
        <span className="muted">View</span>
        <label className="logs-opt">
          Font
          <input
            type="range"
            min={9}
            max={18}
            value={prefs.fontSize}
            onChange={(e) => set({ fontSize: Number(e.target.value) })}
            aria-label="Font size"
          />
        </label>
        <Checkbox checked={prefs.wrap} onChange={(v) => set({ wrap: v })} label="Wrap" />
        <Checkbox
          checked={prefs.showSource}
          onChange={(v) => set({ showSource: v })}
          label="Source column"
        />
        <Checkbox
          checked={prefs.autoscroll}
          onChange={(v) => set({ autoscroll: v })}
          label="Auto-scroll"
        />
      </div>
      <div
        ref={bodyRef}
        className="logs-body"
        style={{ fontSize: prefs.fontSize }}
        role="log"
        aria-label="Log lines"
        data-testid="logs-body"
      >
        {shown.length === 0 && <div className="logs-empty muted">No log lines match.</div>}
        {shown.map((e) => (
          <div key={e.id} className={`logs-row lv-${e.level}${prefs.wrap ? ' wrap' : ''}`}>
            <span className="logs-ts tnum">{formatTime(e.ts)}</span>
            <span className="logs-lv">{e.level.toUpperCase()}</span>
            {prefs.showSource && <span className="logs-src">[{e.source}]</span>}
            <span className="logs-msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

registerModule({ id: 'logs', view: LogsWindow });

log.info('app', 'HT Flow started');
