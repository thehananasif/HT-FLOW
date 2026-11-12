import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  Button,
  Checkbox,
  DropdownMenu,
  Field,
  Input,
  NumberInput,
  Select,
  Slider,
  toast,
} from '@htflow/ui-kit';
import type { ReplayDataInfo } from '@htflow/replay';
import { journalStats, roundTrips } from '@htflow/trading';
import { registerModule, type ModuleViewProps } from '../registry';
import { allInstruments } from '../../state/instruments';
import { paper, pnlTick } from '../../state/market';
import { isTauri } from '../../backend';
import { activeInstrument } from '../../state/windows';
import {
  hideFuture,
  isReplayId,
  REPLAY_ACCOUNT,
  setHideFuture,
  replaySources,
  sourceIdOf,
  startReplay,
  stopReplay,
  type ReplayConfig,
} from '../../feeds/replay';
import { showReplayOn } from './ControlBar';
import {
  addTemplate,
  applyTemplateState,
  fmtBytes,
  fmtClock,
  fmtRange,
  fromLocalInput,
  saveTemplates,
  setReplayDisplay,
  toLocalInput,
  useReplayDisplay,
  useReplaySession,
  useTemplates,
  type ReplayTemplate,
} from './shared';
import './styles.css';

interface SetupParams {
  instruments: string[];
  from: number;
  to: number;
  ticks: boolean;
  depth: boolean;
  /** false = future bars are drawn as faded ghost candles. */
  hideFuture: boolean;
  source: string;
}

function defaults(): SetupParams {
  const cur = activeInstrument();
  const src = cur ? (isReplayId(cur) ? sourceIdOf(cur) : cur) : 'mock:CLZ6';
  const to = Math.floor(Date.now() / 60_000) * 60_000;
  return {
    instruments: [src],
    from: to - 60 * 60_000,
    to,
    ticks: true,
    depth: true,
    hideFuture: true,
    source: '',
  };
}

function readParams(p: Record<string, unknown> | undefined): SetupParams {
  const d = defaults();
  const s = (p?.setup ?? {}) as Partial<SetupParams>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return {
    instruments:
      Array.isArray(s.instruments) && s.instruments.length
        ? s.instruments.filter((x) => typeof x === 'string')
        : d.instruments,
    from: ok(s.from) ? s.from : d.from,
    to: ok(s.to) && ok(s.from) && s.to > s.from ? s.to : d.to,
    ticks: true,
    depth: typeof s.depth === 'boolean' ? s.depth : true,
    hideFuture: typeof s.hideFuture === 'boolean' ? s.hideFuture : true,
    source: typeof s.source === 'string' ? s.source : '',
  };
}

function toConfig(p: SetupParams): ReplayConfig {
  return {
    instruments: p.instruments,
    from: p.from,
    to: p.to,
    layers: { ticks: p.ticks, depth: p.depth, hideFuture: p.hideFuture },
    source: p.source || undefined,
  };
}

async function launch(
  cfg: ReplayConfig,
  setBusy: (b: string | null) => void,
  template?: ReplayTemplate,
) {
  setBusy('Loading data… 0%');
  try {
    const s = await startReplay(template ? { ...cfg, templateId: template.id } : cfg, (p) =>
      setBusy(`Loading data… ${Math.round(p * 100)}%`),
    );
    if (template) applyTemplateState(s, template);
    showReplayOn([...s.engines.keys()]);
    toast('success', 'Replay ready', 'Press Play or Space on the chart');
  } catch (e) {
    toast('error', 'Replay failed', e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(null);
  }
}

function Setup({ state, setParams }: ModuleViewProps) {
  const p = readParams(state.params);
  const set = (patch: Partial<SetupParams>) => setParams({ setup: { ...p, ...patch } });
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<(ReplayDataInfo & { label: string; range?: string }) | null>(
    null,
  );
  const all = allInstruments(isTauri).filter((i) => !isReplayId(i.id));
  const first = p.instruments[0] ?? '';
  const sources = replaySources(first);
  const source = sources.find((s) => s.id === p.source) ?? sources[0];
  useEffect(() => {
    let alive = true;
    if (!source) {
      setInfo(null);
      return;
    }
    void Promise.all([source.info(first, p.from, p.to), source.range(first)]).then(([i, r]) => {
      if (alive)
        setInfo({
          ...i,
          label: source.label,
          range: r ? `${fmtClock(r.from)} → ${fmtClock(r.to)}` : undefined,
        });
    });
    return () => {
      alive = false;
    };
  }, [source, first, p.from, p.to]);
  const valid = p.to > p.from && p.instruments.length > 0 && !!source;
  const symbol = (id: string) => all.find((i) => i.id === id)?.symbol ?? id;
  return (
    <section className="rp-card" aria-label="Replay setup">
      <h4>Replay setup</h4>
      <div className="col gap8">
        <span className="ht-label">Instruments (synced)</span>
        <div className="row gap6 rp-chips">
          {p.instruments.map((id) => (
            <span key={id} className="rp-chip">
              {symbol(id)}
              {p.instruments.length > 1 && (
                <button
                  aria-label={`Remove ${symbol(id)}`}
                  onClick={() => set({ instruments: p.instruments.filter((x) => x !== id) })}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
          <DropdownMenu
            items={all
              .filter((i) => !p.instruments.includes(i.id))
              .map((i) => ({
                id: i.id,
                label: `${i.symbol} · ${i.exchange}`,
                onSelect: () => set({ instruments: [...p.instruments, i.id] }),
              }))}
            trigger={
              <button className="rp-chip rp-chip--add" data-testid="replay-add-instrument">
                + add
              </button>
            }
          />
          <DropdownMenu
            items={all.map((i) => ({
              id: i.id,
              label: `${i.symbol} · ${i.exchange}`,
              checked: i.id === first,
              onSelect: () => set({ instruments: [i.id, ...p.instruments.slice(1)] }),
            }))}
            trigger={
              <button className="rp-chip rp-chip--add" data-testid="replay-instrument">
                Change ▾
              </button>
            }
          />
        </div>
        <div className="row gap8">
          <Field label="From">
            <Input
              type="datetime-local"
              aria-label="From"
              value={toLocalInput(p.from)}
              onChange={(e) => {
                const t = fromLocalInput(e.target.value);
                if (Number.isFinite(t)) set({ from: t });
              }}
            />
          </Field>
          <Field label="To" error={p.to > p.from ? undefined : 'To must be after From'}>
            <Input
              type="datetime-local"
              aria-label="To"
              value={toLocalInput(p.to)}
              onChange={(e) => {
                const t = fromLocalInput(e.target.value);
                if (Number.isFinite(t)) set({ to: t });
              }}
            />
          </Field>
        </div>
        {sources.length > 1 && (
          <Field label="Data source">
            <Select
              value={source?.id ?? ''}
              onChange={(v) => set({ source: v })}
              options={sources.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Field>
        )}
        <Checkbox checked onChange={() => {}} label="Ticks (trades)" />
        <Checkbox
          checked={p.depth}
          onChange={(v) => set({ depth: v })}
          label="Depth of market (heatmap + DOM)"
        />
        <Checkbox
          checked={p.hideFuture}
          onChange={(v) => {
            set({ hideFuture: v });
            setHideFuture(v);
          }}
          label="Hide future bars (no peeking)"
        />
        {!p.hideFuture && (
          <span className="muted rp-sub">
            Future bars show as faded ghost candles after the last real bar.
          </span>
        )}
        <div className="rp-info">
          {source && info ? (
            <>
              <span className="muted">
                {info.where === 'disk'
                  ? 'Data on disk'
                  : info.where === 'memory'
                    ? 'Data in memory'
                    : 'Generated on demand'}
              </span>
              <span className="tnum" data-testid="replay-data-info">
                {symbol(first)} · {fmtBytes(info.bytes)} · {info.trades.toLocaleString()} ticks ·{' '}
                {info.days >= 1 ? `${Math.round(info.days)} days` : 'this session'}
              </span>
              {info.range && <span className="muted rp-sub">Available {info.range}</span>}
            </>
          ) : (
            <span className="muted">
              No recorded data for {symbol(first)} — open it in a chart to record it in memory (tick
              store download arrives with P06).
            </span>
          )}
        </div>
        <Button
          variant="primary"
          block
          disabled={!valid || !!busy}
          data-testid="replay-start"
          onClick={() => void launch(toConfig(p), setBusy)}
        >
          {busy ?? 'Start replay'}
        </Button>
        <div className="row gap8">
          <Button
            size="sm"
            variant="ghost"
            disabled={!valid}
            onClick={() => {
              const name = window.prompt(
                'Template name',
                `${p.instruments.map(symbol).join('+')} ${fmtRange(p.from, p.to)}`,
              );
              if (name) addTemplate(name, toConfig(p));
            }}
          >
            Save as template
          </Button>
        </div>
      </div>
    </section>
  );
}

function Account() {
  useReplaySession();
  const [, set] = useState(0);
  useEffect(() => paper.subscribe(() => set((x) => x + 1)), []);
  const acc = paper.accounts.get(REPLAY_ACCOUNT);
  const fills = paper.fills.filter((f) => f.tag === 'replay');
  const stats = useMemo(() => journalStats(roundTrips(fills, pnlTick)), [fills]);
  if (!acc) return null;
  const positions = paper.allPositions(REPLAY_ACCOUNT);
  const pos = positions[0];
  const pnl = acc.balance - acc.startingBalance;
  const money = (v: number) =>
    `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return (
    <section className="rp-card" aria-label="Replay account">
      <h4>
        Replay account <span className="muted rp-sub">paper · journal tag #replay</span>
      </h4>
      <div className="rp-stats">
        <div className="card-stat">
          <span className="muted">Balance</span>
          <b className="tnum">${acc.balance.toLocaleString('en-US')}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Session P&amp;L</span>
          <b className={`tnum ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>{money(pnl)}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Trades</span>
          <b className="tnum">
            {stats.trades} · {Math.round(stats.winRate * 100)}% win
          </b>
        </div>
        <div className="card-stat">
          <span className="muted">Position</span>
          <b className={`tnum ${pos ? (pos.qty > 0 ? 'up' : 'down') : ''}`}>
            {pos ? `${pos.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos.qty)}` : 'FLAT'}
          </b>
        </div>
      </div>
      <div className="row gap8">
        <Button size="sm" variant="ghost" onClick={() => paper.flattenAll(REPLAY_ACCOUNT)}>
          Flatten replay
        </Button>
        <Button size="sm" variant="ghost" onClick={() => paper.resetAccount(REPLAY_ACCOUNT)}>
          Reset account
        </Button>
      </div>
    </section>
  );
}

function Templates({ setBusy }: { setBusy: (b: string | null) => void }) {
  const list = useTemplates();
  return (
    <section className="rp-card" aria-label="Replay templates">
      <h4>Replay templates</h4>
      {list.length === 0 && (
        <p className="muted rp-sub">
          None yet — save one from the setup or right-click a chart → Add replay template.
        </p>
      )}
      {list.map((t) => (
        <div key={t.id} className="rp-tpl">
          <span className="rp-tpl-name">{t.name}</span>
          <span className="muted tnum">{fmtRange(t.config.from, t.config.to)}</span>
          <span className="muted tnum" title="Saved with this template">
            {(t.bookmarks?.length ?? 0) > 0 ? `${t.bookmarks!.length} bookmarks` : ''}
            {t.loop ? ' · loop' : ''}
          </span>
          <Button size="xs" onClick={() => void launch(t.config, setBusy, t)}>
            Load
          </Button>
          <button
            className="ht-icon-btn"
            aria-label={`Delete ${t.name}`}
            onClick={() => saveTemplates(list.filter((x) => x.id !== t.id))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}

/** Customisation of the replay chart overlays: ghost candles, fill tags, timeline events. */
function Display() {
  const d = useReplayDisplay();
  const hf = hideFuture();
  return (
    <section className="rp-card" aria-label="Replay display">
      <h4>Replay display</h4>
      <div className="col gap8">
        <Checkbox
          checked={d.fillTags}
          onChange={(v) => setReplayDisplay({ fillTags: v })}
          label="B / S fill tags on bars"
        />
        <Checkbox
          checked={d.tagQty}
          onChange={(v) => setReplayDisplay({ tagQty: v })}
          label="Show quantity in the tag"
        />
        <Field label={`Tag size: ${d.tagSize}px`}>
          <Slider
            label="Tag size"
            min={8}
            max={16}
            value={d.tagSize}
            onChange={(v) => setReplayDisplay({ tagSize: v })}
          />
        </Field>
        <Checkbox
          checked={d.timelineEvents}
          onChange={(v) => setReplayDisplay({ timelineEvents: v })}
          label="Economic events on the timeline"
        />
        <Field label="Event impact">
          <Select
            value={d.eventImpact}
            onChange={(v) => setReplayDisplay({ eventImpact: v as typeof d.eventImpact })}
            options={[
              { value: 'all', label: 'All events' },
              { value: 'medium', label: 'Medium and high' },
              { value: 'high', label: 'High only' },
            ]}
          />
        </Field>
        <Checkbox
          checked={hf}
          onChange={(v) => setHideFuture(v)}
          label="Hide future bars (off = ghost candles)"
        />
        <div className="row gap8">
          <Field label="Ghost bars">
            <NumberInput
              value={d.ghostBars}
              min={5}
              max={300}
              onChange={(v) => setReplayDisplay({ ghostBars: v })}
            />
          </Field>
          <Field label={`Ghost opacity: ${Math.round(d.ghostOpacity * 100)}%`}>
            <Slider
              label="Ghost opacity"
              min={10}
              max={90}
              value={Math.round(d.ghostOpacity * 100)}
              onChange={(v) => setReplayDisplay({ ghostOpacity: v / 100 })}
            />
          </Field>
        </div>
      </div>
    </section>
  );
}

function Running() {
  const s = useReplaySession();
  if (!s) return null;
  const e = s.group.primary;
  return (
    <section className="rp-card" aria-label="Running replay">
      <h4>
        Running <span className="ht-badge ht-badge--replay">Replay</span>
      </h4>
      <div className="row gap8 rp-running">
        <span className="tnum">{fmtClock(e.time)}</span>
        <span className="muted">
          {[...s.engines.keys()].map((id) => sourceIdOf(id).replace(/^mock:/, '')).join(' + ')} ·{' '}
          {e.speed}× · {e.playing ? 'playing' : 'paused'}
        </span>
        <div className="grow" />
        <Button size="xs" onClick={() => showReplayOn([...s.engines.keys()])}>
          Show on chart
        </Button>
        <Button size="xs" variant="ghost" onClick={stopReplay}>
          Stop
        </Button>
      </div>
    </section>
  );
}

registerModule({
  id: 'replay',
  view: function ReplayWindow(props: ModuleViewProps) {
    const [busy, setBusy] = useState<string | null>(null);
    return (
      <div className="module-window rp-window" data-testid="replay-window">
        <div className="rp-cols">
          <div className="col gap12">
            <Running />
            <Setup {...props} />
          </div>
          <div className="col gap12">
            <Account />
            <Templates setBusy={setBusy} />
            <Display />
            {busy && <span className="muted">{busy}</span>}
          </div>
        </div>
      </div>
    );
  },
});
