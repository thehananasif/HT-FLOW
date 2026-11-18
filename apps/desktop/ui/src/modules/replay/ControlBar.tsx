import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, SkipBack, Square, StepBack, StepForward } from 'lucide-react';
import { Button, Checkbox, Dialog, Field, Input, toast } from '@htflow/ui-kit';
import type { BarSpec } from '@htflow/market-data';
import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import { ghostBars, REPLAY_SPEEDS, type ReplayEngine } from '@htflow/replay';
import { specKey, type Bar } from '@htflow/market-data';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { registerChartExtension, type ChartExtensionContext } from '../../charts/extensions';
import { chartAction } from '../../charts/bus';
import { registerCommands } from '../../shell/commands';
import { useWindows } from '../../state/windows';
import { paper } from '../../state/market';
import {
  hideFuture,
  isReplayId,
  onReplaySession,
  replayEngine,
  replayInstrument,
  replaySession,
  setHideFuture,
  sourceIdOf,
  stopReplay,
  REPLAY_ACCOUNT,
  type ReplayConfig,
} from '../../feeds/replay';
import { allEvents, calendar } from '../calendar/store';
import { timeToX } from '../calendar/chartLines';
import {
  edgeLabel,
  exitReplayTargets,
  fillTags,
  loopBand,
  savedStateOf,
  timelineEvents,
} from './logic';
import {
  addTemplate,
  onReplayDisplay,
  replayDisplay,
  useReplayDisplay,
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
  return s.template === 'liquidity-map' ? { kind: 'time', ms: 60_000 } : (s.timeframe as BarSpec);
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
  /** Jump / Go to time: the replay clock moves there, and so does the view (newest bar at the right). */
  seek: (id: string, t: number) => {
    act(id, (e) => replaySession()?.group.seek(t, e));
    anchorReplayCharts();
  },
};

/** Puts the newest replay bar back at the right margin of every chart showing a replay instrument. */
export function anchorReplayCharts(): void {
  for (const [wid, w] of Object.entries(useWindows.getState().windows))
    if (w.kind === 'chart' && isReplayId(w.instrumentId)) chartAction('go-latest', wid);
}

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
  const display = useReplayDisplay();
  const [calTick, setCalTick] = useState(0);
  useEffect(() => {
    void calendar.ensureLoaded();
    return calendar.subscribe(() => setCalTick((x) => x + 1));
  }, []);
  const events = useMemo(
    () =>
      display.timelineEvents
        ? timelineEvents(
            allEvents(calendar.get(), e.start),
            e.start,
            e.end,
            replayInstrument(sourceIdOf(id)),
            display.eventImpact,
          )
        : [],
    // calTick re-evaluates when the calendar changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display.timelineEvents, display.eventImpact, e.start, e.end, id, calTick],
  );
  return (
    <div className="rp-timeline">
      <span className="tnum muted">{edgeLabel(e.start, span)}</span>
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
        onPointerCancel={() => setDrag(null)}
        onPointerUp={(ev) => {
          if (drag === null) return;
          setDrag(null);
          replayControls.seek(id, tAt(ev.clientX));
        }}
      >
        {e.loop && <span className="rp-loop" style={loopBand(e.loop, e.start, e.end)} />}
        <span className="rp-fill" style={{ width: `${frac * 100}%` }} />
        <span className="rp-thumb" style={{ left: `${frac * 100}%` }} />
        {events.map((ev) => (
          <span
            key={ev.uid}
            className={`rp-evt rp-evt--${ev.impact}`}
            style={{ left: pct(ev.t) }}
            title={`${ev.currency ? ev.currency + ' · ' : ''}${ev.title} · ${fmtHm(ev.t)}`}
            data-testid="replay-event"
            onPointerDown={(pe) => {
              pe.stopPropagation();
              replayControls.seek(id, ev.t);
            }}
          />
        ))}
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
      <span className="tnum muted">{edgeLabel(e.end, span)}</span>
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
          {e.progressTrades.done.toLocaleString()} / {e.progressTrades.total.toLocaleString()} ticks
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
        <button
          className="rp-btn"
          aria-label="Stop replay"
          title="Stop replay and go back to the live chart"
          data-testid="replay-stop"
          onClick={exitReplay}
        >
          <Square size={12} />
          Stop
        </button>
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
          checked={hideFuture()}
          onChange={(v) => setHideFuture(v)}
          label="Hide future bars"
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

/** Faded future candles after the last real bar when "Hide future bars" is off. */
class GhostLayer implements ChartLayer {
  readonly id = 'replay-ghost';
  private cache: { key: string; bars: Bar[] } | null = null;
  constructor(private ctx: ChartExtensionContext) {}

  draw(v: ChartView): void {
    const st = this.ctx.state();
    if (!isReplayId(st.instrumentId) || hideFuture()) return;
    const e = replayEngine(st.instrumentId);
    const series = this.ctx.series();
    if (!e || !series || !series.bars.length) return;
    const spec = specOf(st);
    const last = series.bars[series.bars.length - 1]!;
    const n = replayDisplay().ghostBars;
    const key = `${specKey(spec)}|${n}|${last.t}|${spec.kind === 'time' ? '' : e.tradeIndex}`;
    if (this.cache?.key !== key)
      this.cache = {
        key,
        bars: ghostBars(e.dataset.trades, e.tradeIndex, spec, last.t, { maxBars: n }),
      };
    const bars = this.cache.bars;
    if (!bars.length) return;
    const { ctx, palette: p } = v;
    const w = Math.max(1, Math.min(v.slotWidth * 0.7, 40));
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.globalAlpha = replayDisplay().ghostOpacity;
    const base = series.bars.length;
    bars.forEach((b, k) => {
      const x = v.xOf(base + k);
      if (x < v.plot.x - w || x > v.plot.x + v.plot.w + w) return;
      const col = b.c >= b.o ? p.up : p.down;
      const yO = v.yOf(b.o);
      const yC = v.yOf(b.c);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, v.yOf(b.h));
      ctx.lineTo(Math.round(x) + 0.5, v.yOf(b.l));
      ctx.stroke();
      ctx.fillRect(x - w / 2, Math.min(yO, yC), w, Math.max(1, Math.abs(yC - yO)));
    });
    ctx.globalAlpha = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = p.textTertiary;
    const xs = v.xOf(base - 0.5);
    ctx.beginPath();
    ctx.moveTo(xs, v.plot.y);
    ctx.lineTo(xs, v.plot.y + v.plot.h);
    ctx.stroke();
    ctx.restore();
  }
}

/** B / S fill tags on the bars where replay-routed orders filled. */
class FillTagsLayer implements ChartLayer {
  readonly id = 'replay-fills';
  constructor(private ctx: ChartExtensionContext) {}

  draw(v: ChartView): void {
    const n = this.drawTags(v);
    // Number of tags in the last frame on the canvas (`data-replay-tags`): a deterministic signal
    // for tests that compare screenshots with tags on / off.
    const el = (v.ctx as { canvas?: HTMLCanvasElement }).canvas;
    if (el?.dataset && el.dataset.replayTags !== String(n)) el.dataset.replayTags = String(n);
  }

  private drawTags(v: ChartView): number {
    const st = this.ctx.state();
    const d = replayDisplay();
    if (!d.fillTags || !isReplayId(st.instrumentId)) return 0;
    const e = replayEngine(st.instrumentId);
    const series = this.ctx.series();
    if (!e || !series || !series.bars.length) return 0;
    const tags = fillTags(paper.fills, st.instrumentId, e.time, d.tagQty);
    if (!tags.length) return 0;
    let drawn = 0;
    const barMs = st.timeframe.kind === 'time' ? st.timeframe.ms : null;
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.font = v.font(d.tagSize, 700);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const t of tags) {
      const x = timeToX(series.bars, t.ts, v, barMs);
      if (x === null || x < v.plot.x || x > v.plot.x + v.plot.w) continue;
      const y = v.yOf(t.px);
      if (!Number.isFinite(y)) continue;
      const buy = t.side === 'buy';
      const w = ctx.measureText(t.text).width + 8;
      const h = d.tagSize + 6;
      // Buys sit below the fill and sells above it; flip when that would leave the plot, so a fill
      // near the top / bottom edge still shows its tag.
      let below = buy;
      if (below && y + 6 + h > v.plot.y + v.plot.h) below = false;
      else if (!below && y - 6 - h < v.plot.y) below = true;
      const ty = below ? y + 6 + h / 2 : y - 6 - h / 2;
      if (ty + h / 2 < v.plot.y || ty - h / 2 > v.plot.y + v.plot.h) continue;
      ctx.fillStyle = buy ? p.up : p.down;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 4, below ? ty - h / 2 : ty + h / 2);
      ctx.lineTo(x + 4, below ? ty - h / 2 : ty + h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - w / 2, ty - h / 2, w, h);
      ctx.fillStyle = '#000000';
      ctx.fillText(t.text, x, ty);
      drawn++;
    }
    ctx.restore();
    return drawn;
  }
}

registerChartExtension({
  id: 'replay',
  Overlay: ReplayOverlay,
  layers: (ctx) => [new GhostLayer(ctx), new FillTagsLayer(ctx)],
  attach: (ctx) => {
    const redraw = () => ctx.cores.forEach((c) => c.invalidate());
    const un1 = paper.subscribe(redraw);
    const un2 = onReplayDisplay(redraw);
    const un3 = onReplaySession(redraw);
    return () => (un1(), un2(), un3());
  },
  menu: (ctx) => [
    ...(isReplayId(ctx.state().instrumentId)
      ? [
          {
            id: 'replay-hide-future',
            label: 'Hide future bars',
            checked: hideFuture(),
            onSelect: () => setHideFuture(!hideFuture()),
          },
        ]
      : []),
    {
      id: 'replay-template',
      label: 'Add replay template',
      onSelect: () => {
        const s = ctx.state();
        const cfg = configForChart(s);
        const sym = ctx.store.instrument.symbol;
        void loadTemplates().then(() => {
          const name = `${sym} ${fmtHm(cfg.from)}–${fmtHm(cfg.to)}`;
          const eng = replayEngine(s.instrumentId);
          addTemplate(name, cfg, eng ? savedStateOf(eng.bookmarks, eng.loop) : undefined);
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
  return w && w.kind === 'chart' && isReplayId(w.instrumentId) ? { id: activeId!, state: w } : null;
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
      {
        id: 'replay.stop',
        label: 'Replay: stop and return to the live chart',
        group: 'Chart',
        run: () => exitReplay(),
      },
      {
        id: 'replay.hide-future',
        label: 'Replay: toggle hide future bars (ghost candles)',
        group: 'Chart',
        run: () => setHideFuture(!hideFuture()),
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

/** The chart a replay is shown on: the active chart, else the first one. */
function replayChartId(): string | undefined {
  const { activeId, windows } = useWindows.getState();
  const charts = Object.entries(windows).filter(([, w]) => w.kind === 'chart');
  return (activeId && windows[activeId]?.kind === 'chart' ? activeId : null) ?? charts[0]?.[0];
}

/** Bar length of the chart the replay will be shown on (turns "History before start" bars into time). */
export function replayChartBarMs(): number | undefined {
  const id = replayChartId();
  const w = id ? useWindows.getState().windows[id] : undefined;
  if (w?.kind !== 'chart') return undefined;
  const spec = specOf(w as ChartWindowState);
  return spec.kind === 'time' ? spec.ms : undefined;
}

/** Switches the active chart (and its link group) to the replay instrument. */
export function showReplayOn(replayIds: string[]): void {
  const { patch } = useWindows.getState();
  const first = replayChartId();
  if (!first || !replayIds[0]) {
    toast('info', 'Open a chart to show the replay');
    return;
  }
  patch(first, { instrumentId: replayIds[0] } as Partial<WindowState>);
  useWindows.getState().setActive(first);
  // Already on the replay (maybe panned into the history): back to the newest bar.
  chartAction('go-latest', first);
  // Further synced instruments go to charts that show their source instrument.
  for (const rid of replayIds.slice(1)) {
    const src = sourceIdOf(rid);
    for (const [k, w] of Object.entries(useWindows.getState().windows))
      if (w.kind !== 'module' && w.instrumentId === src)
        patch(k, { instrumentId: rid } as Partial<WindowState>);
  }
}

/**
 * Leaves replay: closes open replay positions at the replay price (they have no price once the
 * session is gone), stops the clock and puts every chart that shows a replay instrument back on
 * its live / simulated instrument, so no stale replay bars stay on screen.
 */
export function exitReplay(): void {
  try {
    paper.flattenAll(REPLAY_ACCOUNT);
  } catch {
    // Nothing to flatten (no book): the account card can reset it.
  }
  stopReplay();
  const { windows, patch, setActive, activeId } = useWindows.getState();
  const inst: Record<string, string | undefined> = {};
  for (const [id, w] of Object.entries(windows))
    inst[id] = w.kind === 'module' ? undefined : w.instrumentId;
  const targets = exitReplayTargets(inst);
  for (const t of targets) {
    const cur = useWindows.getState().windows[t.id];
    // A linked chart may already have been switched by the previous patch.
    if (cur && cur.kind !== 'module' && isReplayId(cur.instrumentId))
      patch(t.id, { instrumentId: t.instrumentId } as Partial<WindowState>);
  }
  if (targets[0] && !activeId) setActive(targets[0].id);
  if (targets.length) toast('info', 'Replay stopped', 'Back on the live chart');
}
