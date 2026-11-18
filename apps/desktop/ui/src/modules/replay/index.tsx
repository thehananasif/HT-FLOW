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
import { exchangeHistoryAvailable } from '../../feeds/exchangeHistory';
import { registerModule, type ModuleViewProps } from '../registry';
import { allInstruments } from '../../state/instruments';
import { hub, paper, pnlTick } from '../../state/market';
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
  type ReplayConfig,
} from '../../feeds/replay';
import { exitReplay, showReplayOn } from './ControlBar';
import { pickSourceId, validateRange } from './logic';
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

import { translateLiteral as tl, tt } from '@htflow/i18n';
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
    toast('success', tl('Replay ready'), tl('Press Play or Space on the chart'));
  } catch (e) {
    toast('error', tl('Replay failed'), e instanceof Error ? e.message : String(e));
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
  const all = allInstruments(isTauri || exchangeHistoryAvailable()).filter(
    (i) => !isReplayId(i.id),
  );
  const first = p.instruments[0] ?? '';
  const sources = replaySources(first);
  const sourceKey = sources.map((s) => s.id).join(',');
  // Without an explicit choice the source whose data covers the range wins (same rule as start).
  const [auto, setAuto] = useState('');
  useEffect(() => {
    let alive = true;
    void Promise.all(
      replaySources(first).map(async (s) => ({
        id: s.id,
        range: await s.range(first).catch(() => null),
      })),
    ).then((r) => {
      if (alive) setAuto(pickSourceId(r, p.from, p.to) ?? '');
    });
    return () => {
      alive = false;
    };
  }, [first, p.from, p.to, sourceKey]);
  const source = sources.find((s) => s.id === (p.source || auto)) ?? sources[0];
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
  const rangeError = validateRange(p.from, p.to, Date.now(), info?.bytes ?? 0);
  const valid = !rangeError && p.instruments.length > 0 && !!source;
  const symbol = (id: string) => all.find((i) => i.id === id)?.symbol ?? id;
  return (
    <section className="rp-card" aria-label={tl('Replay setup')}>
      <h4>{tl('Replay setup')}</h4>
      <div className="col gap8">
        <span className="ht-label">{tl('Instruments (synced)')}</span>
        <div className="row gap6 rp-chips">
          {p.instruments.map((id) => (
            <span key={id} className="rp-chip">
              {symbol(id)}
              {p.instruments.length > 1 && (
                <button
                  aria-label={tt`Remove ${symbol(id)}`}
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
                {tl('+ add')}
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
                {tl('Change ▾')}
              </button>
            }
          />
        </div>
        <div className="row gap8">
          <Field label={tl('From')}>
            <Input
              type="datetime-local"
              aria-label={tl('From')}
              value={toLocalInput(p.from)}
              onChange={(e) => {
                const t = fromLocalInput(e.target.value);
                if (Number.isFinite(t)) set({ from: t });
              }}
            />
          </Field>
          <Field label={tl('To')} error={rangeError ?? undefined}>
            <Input
              type="datetime-local"
              aria-label={tl('To')}
              value={toLocalInput(p.to)}
              onChange={(e) => {
                const t = fromLocalInput(e.target.value);
                if (Number.isFinite(t)) set({ to: t });
              }}
            />
          </Field>
        </div>
        {sources.length > 1 && (
          <Field label={tl('Data source')}>
            <Select
              value={source?.id ?? ''}
              onChange={(v) => set({ source: v })}
              options={sources.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Field>
        )}
        <Checkbox checked onChange={() => {}} label={tl('Ticks (trades)')} />
        <Checkbox
          checked={p.depth}
          onChange={(v) => set({ depth: v })}
          label={tl('Depth of market (heatmap + DOM)')}
        />
        <Checkbox
          checked={p.hideFuture}
          onChange={(v) => {
            set({ hideFuture: v });
            setHideFuture(v);
          }}
          label={tl('Hide future bars (no peeking)')}
        />
        {!p.hideFuture && (
          <span className="muted rp-sub">
            {tl('Future bars show as faded ghost candles after the last real bar.')}
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
                    : info.where === 'exchange'
                      ? 'Downloaded from the exchange when you start'
                      : 'Generated on demand'}
              </span>
              <span className="tnum" data-testid="replay-data-info">
                {symbol(first)} · {fmtBytes(info.bytes)} · {info.trades.toLocaleString()}{' '}
                {tl('ticks ·')} {info.days >= 1 ? `${Math.round(info.days)} days` : 'this session'}
              </span>
              {info.range && (
                <span className="muted rp-sub">
                  {tl('Available')} {info.range}
                </span>
              )}
              {info.note && <span className="muted rp-sub">{info.note}</span>}
            </>
          ) : (
            <span className="muted">
              {tl('No data source covers')} {symbol(first)}
              {tl(
                ': open it in a chart to record it in memory, or connect its exchange to download history.',
              )}
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
            {tl('Save as template')}
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
  const realized = acc.balance - acc.startingBalance;
  const open = positions.reduce((sum, q) => {
    const mark = hub.peek(q.instrumentId)?.lastTrade?.px;
    return mark === undefined ? sum : sum + paper.unrealized(REPLAY_ACCOUNT, q.instrumentId, mark);
  }, 0);
  const pnl = realized + open;
  const money = (v: number) =>
    `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return (
    <section className="rp-card" aria-label={tl('Replay account')}>
      <h4>
        {tl('Replay account')}{' '}
        <span className="muted rp-sub">{tl('paper · journal tag #replay')}</span>
      </h4>
      <div className="rp-stats">
        <div className="card-stat">
          <span className="muted">{tl('Balance')}</span>
          <b className="tnum">${acc.balance.toLocaleString('en-US')}</b>
        </div>
        <div className="card-stat">
          <span className="muted" title={tt`Realized ${money(realized)} · open ${money(open)}`}>
            Session P&amp;L
          </span>
          <b className={`tnum ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>{money(pnl)}</b>
        </div>
        <div className="card-stat">
          <span className="muted">{tl('Trades')}</span>
          <b className="tnum">
            {stats.trades} · {Math.round(stats.winRate * 100)}
            {tl('% win')}
          </b>
        </div>
        <div className="card-stat">
          <span className="muted">{tl('Position')}</span>
          <b className={`tnum ${pos ? (pos.qty > 0 ? 'up' : 'down') : ''}`}>
            {pos ? `${pos.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos.qty)}` : 'FLAT'}
          </b>
        </div>
      </div>
      <div className="row gap8">
        <Button size="sm" variant="ghost" onClick={() => paper.flattenAll(REPLAY_ACCOUNT)}>
          {tl('Flatten replay')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => paper.resetAccount(REPLAY_ACCOUNT)}>
          {tl('Reset account')}
        </Button>
      </div>
    </section>
  );
}

function Templates({ setBusy }: { setBusy: (b: string | null) => void }) {
  const list = useTemplates();
  return (
    <section className="rp-card" aria-label={tl('Replay templates')}>
      <h4>{tl('Replay templates')}</h4>
      {list.length === 0 && (
        <p className="muted rp-sub">
          {tl('None yet — save one from the setup or right-click a chart → Add replay template.')}
        </p>
      )}
      {list.map((t) => (
        <div key={t.id} className="rp-tpl">
          <span className="rp-tpl-name">{t.name}</span>
          <span className="muted tnum">{fmtRange(t.config.from, t.config.to)}</span>
          <span className="muted tnum" title={tl('Saved with this template')}>
            {(t.bookmarks?.length ?? 0) > 0 ? `${t.bookmarks!.length} bookmarks` : ''}
            {t.loop ? ' · loop' : ''}
          </span>
          <Button size="xs" onClick={() => void launch(t.config, setBusy, t)}>
            {tl('Load')}
          </Button>
          <button
            className="ht-icon-btn"
            aria-label={tt`Delete ${t.name}`}
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
  useReplaySession(); // re-render when the session (e.g. hide-future) changes
  const d = useReplayDisplay();
  const hf = hideFuture();
  return (
    <section className="rp-card" aria-label={tl('Replay display')}>
      <h4>{tl('Replay display')}</h4>
      <div className="col gap8">
        <Checkbox
          checked={d.fillTags}
          onChange={(v) => setReplayDisplay({ fillTags: v })}
          label={tl('B / S fill tags on bars')}
        />
        <Checkbox
          checked={d.tagQty}
          onChange={(v) => setReplayDisplay({ tagQty: v })}
          label={tl('Show quantity in the tag')}
        />
        <Field label={tt`Tag size: ${d.tagSize}px`}>
          <Slider
            label={tl('Tag size')}
            min={8}
            max={16}
            value={d.tagSize}
            onChange={(v) => setReplayDisplay({ tagSize: v })}
          />
        </Field>
        <Checkbox
          checked={d.timelineEvents}
          onChange={(v) => setReplayDisplay({ timelineEvents: v })}
          label={tl('Economic events on the timeline')}
        />
        <Field label={tl('Event impact')}>
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
          label={tl('Hide future bars (off = ghost candles)')}
        />
        <div className="row gap8">
          <Field label={tl('Ghost bars')}>
            <NumberInput
              value={d.ghostBars}
              min={5}
              max={300}
              onChange={(v) => setReplayDisplay({ ghostBars: v })}
            />
          </Field>
          <Field label={tt`Ghost opacity: ${Math.round(d.ghostOpacity * 100)}%`}>
            <Slider
              label={tl('Ghost opacity')}
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
    <section className="rp-card" aria-label={tl('Running replay')}>
      <h4>
        {tl('Running')} <span className="ht-badge ht-badge--replay">{tl('Replay')}</span>
      </h4>
      <div className="row gap8 rp-running">
        <span className="tnum">{fmtClock(e.time)}</span>
        <span className="muted">
          {[...s.engines.keys()].map((id) => sourceIdOf(id).replace(/^mock:/, '')).join(' + ')} ·{' '}
          {e.speed}× · {e.playing ? 'playing' : 'paused'}
        </span>
        <div className="grow" />
        <Button size="xs" onClick={() => showReplayOn([...s.engines.keys()])}>
          {tl('Show on chart')}
        </Button>
        <Button size="xs" variant="ghost" onClick={exitReplay}>
          {tl('Stop')}
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
