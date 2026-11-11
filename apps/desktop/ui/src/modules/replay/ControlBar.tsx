import { useRef, useState } from 'react';
import { Pause, Play, SkipBack, StepBack, StepForward } from 'lucide-react';
import { Button, Checkbox, Dialog, Field, Input, toast } from '@htflow/ui-kit';
import type { BarSpec } from '@htflow/market-data';
import { REPLAY_SPEEDS, type ReplayEngine } from '@htflow/replay';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { registerChartExtension } from '../../charts/extensions';
import { registerCommands } from '../../shell/commands';
import { useWindows } from '../../state/windows';
import {
  isReplayId,
  replayEngine,
  replaySession,
  sourceIdOf,
  type ReplayConfig,
} from '../../feeds/replay';
import {
  addTemplate,
  fmtClock,
  fmtHm,
  fromLocalInput,
  loadTemplates,
  toLocalInput,
  useReplayEngine,
} from './shared';

const speedLabel = (x: number) => `${x}×`;

/** Bar type used by step bar: the chart's timeframe (1 min for the liquidity map). */
function specOf(s: ChartWindowState): BarSpec {
  return s.template === 'liquidity-map'
    ? { kind: 'time', ms: 60_000 }
    : (s.timeframe as BarSpec);
}

// Control helpers act on the whole group when "Sync all windows" is on.
function act(id: string, fn: (e: ReplayEngine) => void) {
  const e = replayEngine(id);
  if (e) fn(e);
}
export const replayControls = {
  toggle: (id: string) => act(id, (e) => replaySession()?.group.toggle(e)),
  speed: (id: string, x: number) => act(id, (e) => replaySession()?.group.setSpeed(x, e)),
  stepBar: (id: string, spec: BarSpec) => act(id, (e) => replaySession()?.group.stepBar(spec, e)),
  stepBack: (id: string, spec: BarSpec) =>
    act(id, (e) => replaySession()?.group.stepBackBar(spec, e)),
  stepTick: (id: string) => act(id, (e) => replaySession()?.group.stepTick(e)),
  seek: (id: string, t: number) => act(id, (e) => replaySession()?.group.seek(t, e)),
};

function Timeline({ id, e }: { id: string; e: ReplayEngine }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const span = Math.max(1, e.end - e.start);
  const frac = ((drag ?? e.time) - e.start) / span;
  const tAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return e.start + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const pct = (t: number) => `${(((t - e.start) / span) * 100).toFixed(3)}%`;
  return (
    <div className="rp-timeline">
      <span className="tnum muted">{fmtHm(e.start)}</span>
      <div
        ref={ref}
        className="rp-track"
        role="slider"
        aria-label="Replay timeline"
        aria-valuemin={e.start}
        aria-valuemax={e.end}
        aria-valuenow={Math.round(e.time)}
        data-testid="replay-timeline"
        onPointerDown={(ev) => {
          (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
          setDrag(tAt(ev.clientX));
        }}
        onPointerMove={(ev) => drag !== null && setDrag(tAt(ev.clientX))}
        onPointerUp={(ev) => {
          if (drag === null) return;
          setDrag(null);
          replayControls.seek(id, tAt(ev.clientX));
        }}
      >
        {e.loop && (
          <span
            className="rp-loop"
            style={{ left: pct(e.loop.from), width: pct(e.start + e.loop.to - e.loop.from) }}
          />
        )}
        <span className="rp-fill" style={{ width: `${frac * 100}%` }} />
        <span className="rp-thumb" style={{ left: `${frac * 100}%` }} />
        {e.bookmarks.map((b) => (
          <span
            key={b.id}
            className="rp-mark"
            style={{ left: pct(b.t) }}
            title={`${b.label} · ${fmtHm(b.t)}`}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              replayControls.seek(id, b.t);
            }}
          >
            ▲ <span>{b.label}</span>
          </span>
        ))}
      </div>
      <span className="tnum muted">{fmtHm(e.end)}</span>
    </div>
  );
}

function GoToDialog({
  id,
  e,
  open,
  onOpenChange,
}: {
  id: string;
  e: ReplayEngine;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [v, setV] = useState(toLocalInput(e.time));
  const t = fromLocalInput(v);
  const ok = Number.isFinite(t) && t >= e.start - 60_000 && t <= e.end;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Go to time" width={360}>
      <form
        className="col gap12"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!ok) return;
          replayControls.seek(id, t);
          onOpenChange(false);
        }}
      >
        <Field
          label="Replay time"
          error={ok ? undefined : `Between ${fmtClock(e.start)} and ${fmtClock(e.end)}`}
        >
          <Input
            type="datetime-local"
            aria-label="Replay time"
            value={v}
            onChange={(x) => setV(x.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!ok}>
          Go
        </Button>
      </form>
    </Dialog>
  );
}

/** Replay control bar (P35 board 11), shown on charts whose instrument is `replay:…`. */
function ReplayOverlay({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  const id = state.instrumentId;
  const e = useReplayEngine(isReplayId(id) ? id : '');
  const [goto, setGoto] = useState(false);
  if (!isReplayId(id)) return null;
  if (!e)
    return (
      <div className="rp-bar" data-testid="replay-bar">
        <span className="muted">Loading replay…</span>
      </div>
    );
  const group = replaySession()?.group;
  const spec = specOf(state);
  return (
    <div className="rp-bar" data-testid="replay-bar" onMouseDown={(ev) => ev.stopPropagation()}>
      <div className="rp-clock">
        <span className="rp-tag">REPLAY</span>
        <span className="tnum" data-testid="replay-clock">
          {fmtClock(e.time)}
        </span>
        <span className="muted tnum">
          {e.tradeIndex.toLocaleString()} / {e.dataset.trades.length.toLocaleString()} ticks
        </span>
      </div>
      <Timeline id={id} e={e} />
      <div className="rp-row">
        <button
          className="rp-btn"
          aria-label="Jump to start"
          title="Jump to start"
          onClick={() => replayControls.seek(id, e.loop?.from ?? e.start)}
        >
          <SkipBack size={13} />
        </button>
        <button
          className="rp-btn"
          aria-label="Step back bar"
          title="Step back bar (←)"
          onClick={() => replayControls.stepBack(id, spec)}
        >
          <StepBack size={13} />
        </button>
        <button
          className="rp-btn rp-play"
          aria-label={e.playing ? 'Pause' : 'Play'}
          title="Play / pause (Space)"
          data-testid="replay-play"
          onClick={() => replayControls.toggle(id)}
        >
          {e.playing ? <Pause size={13} /> : <Play size={13} />}
          {e.playing ? 'Pause' : 'Play'}
        </button>
        <button
          className="rp-btn"
          aria-label="Step bar"
          title="Step forward bar (→)"
          data-testid="replay-step-bar"
          onClick={() => replayControls.stepBar(id, spec)}
        >
          <StepForward size={13} />
        </button>
        <button
          className="rp-btn"
          title="Step tick (Shift+→)"
          data-testid="replay-step-tick"
          onClick={() => replayControls.stepTick(id)}
        >
          Step tick
        </button>
        <div className="ht-seg rp-speeds" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((x, i) => (
            <button
              key={x}
              type="button"
              aria-pressed={e.speed === x}
              title={`${speedLabel(x)} (${i + 1})`}
              onClick={() => replayControls.speed(id, x)}
            >
              {speedLabel(x)}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button className="rp-btn" onClick={() => setGoto(true)}>
          Go to time…
        </button>
        <button
          className="rp-btn"
          onClick={() => {
            group?.addBookmark(e.time, `Bookmark ${e.bookmarks.length + 1}`, e);
          }}
        >
          + Bookmark
        </button>
        <Checkbox
          checked={group?.sync ?? true}
          onChange={(v) => {
            if (group) group.sync = v;
            e.setBookmarks(e.bookmarks); // re-render
          }}
          label="Sync all windows"
        />
        <Checkbox
          checked={!!e.loop}
          onChange={(v) => {
            const bm = e.bookmarks;
            const range =
              bm.length >= 2
                ? { from: bm[0]!.t, to: bm[bm.length - 1]!.t }
                : { from: e.time, to: Math.min(e.end, e.time + 15 * 60_000) };
            group?.setLoop(v ? range : null, e);
          }}
          label="Loop range"
        />
      </div>
      {goto && <GoToDialog id={id} e={e} open={goto} onOpenChange={setGoto} />}
      <span hidden>{windowId}</span>
    </div>
  );
}

function configForChart(s: ChartWindowState): ReplayConfig {
  const e = replayEngine(s.instrumentId);
  const sess = replaySession();
  if (e && sess)
    return {
      ...sess.config,
      instruments: [sourceIdOf(s.instrumentId)],
      from: e.start,
      to: e.end,
    };
  const to = Date.now();
  return {
    instruments: [s.instrumentId],
    from: to - 60 * 60_000,
    to,
    layers: { ticks: true, depth: true, hideFuture: true },
  };
}

registerChartExtension({
  id: 'replay',
  Overlay: ReplayOverlay,
  menu: (ctx) => [
    {
      id: 'replay-template',
      label: 'Add replay template',
      onSelect: () => {
        const s = ctx.state();
        const cfg = configForChart(s);
        const sym = ctx.store.instrument.symbol;
        void loadTemplates().then(() => {
          const name = `${sym} ${fmtHm(cfg.from)}–${fmtHm(cfg.to)}`;
          addTemplate(name, cfg);
          toast('success', 'Replay template saved', name);
        });
      },
    },
  ],
});

// ------------------------------------------------------------------ keyboard (active replay chart)

function activeReplayChart(): { id: string; state: ChartWindowState } | null {
  const { activeId, windows } = useWindows.getState();
  const w = activeId ? windows[activeId] : undefined;
  return w && w.kind === 'chart' && isReplayId(w.instrumentId)
    ? { id: activeId!, state: w }
    : null;
}

let unregister: (() => void) | null = null;
function syncCommands(): void {
  const active = activeReplayChart();
  if (!active && unregister) {
    unregister();
    unregister = null;
  } else if (active && !unregister) {
    const run = (fn: (id: string, s: ChartWindowState) => void) => () => {
      const a = activeReplayChart();
      if (a) fn(a.state.instrumentId, a.state);
    };
    unregister = registerCommands([
      {
        id: 'replay.toggle',
        label: 'Replay: play / pause',
        group: 'Chart',
        shortcut: 'Space',
        run: run((id) => replayControls.toggle(id)),
      },
      {
        id: 'replay.step-bar',
        label: 'Replay: step bar',
        group: 'Chart',
        shortcut: 'ArrowRight',
        run: run((id, s) => replayControls.stepBar(id, specOf(s))),
      },
      {
        id: 'replay.step-back',
        label: 'Replay: step back bar',
        group: 'Chart',
        shortcut: 'ArrowLeft',
        run: run((id, s) => replayControls.stepBack(id, specOf(s))),
      },
      {
        id: 'replay.step-tick',
        label: 'Replay: step tick',
        group: 'Chart',
        shortcut: 'Shift+ArrowRight',
        run: run((id) => replayControls.stepTick(id)),
      },
      ...REPLAY_SPEEDS.map((x, i) => ({
        id: `replay.speed.${i + 1}`,
        label: `Replay speed ${speedLabel(x)}`,
        group: 'Chart' as const,
        shortcut: String(i + 1),
        run: run((id) => replayControls.speed(id, x)),
      })),
    ]);
  }
}
useWindows.subscribe(syncCommands);

/** Switches the active chart (and its link group) to the replay instrument. */
export function showReplayOn(replayIds: string[]): void {
  const { activeId, windows, patch } = useWindows.getState();
  const charts = Object.entries(windows).filter(([, w]) => w.kind === 'chart');
  const first =
    (activeId && windows[activeId]?.kind === 'chart' ? activeId : null) ?? charts[0]?.[0];
  if (!first || !replayIds[0]) {
    toast('info', 'Open a chart to show the replay');
    return;
  }
  patch(first, { instrumentId: replayIds[0] } as Partial<WindowState>);
  useWindows.getState().setActive(first);
  // Further synced instruments go to charts that show their source instrument.
  for (const rid of replayIds.slice(1)) {
    const src = sourceIdOf(rid);
    for (const [k, w] of Object.entries(useWindows.getState().windows))
      if (w.kind !== 'module' && w.instrumentId === src)
        patch(k, { instrumentId: rid } as Partial<WindowState>);
  }
}
