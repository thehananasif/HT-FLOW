import {
  findMockInstrument,
  type EventBatch,
  type FeedSource,
  type FeedStatus,
  type HistoryData,
  type Instrument,
} from '@htflow/market-data';
import {
  DEFAULT_LAYERS,
  DEFAULT_LOOKBACK,
  loadLookback,
  lookbackMs,
  MemorySource,
  ReplayEngine,
  ReplayGroup,
  ReplayScheduler,
  SimulatedSource,
  withLookback,
  type ReplayDataSource,
  type ReplayLayers,
  type ReplayLookback,
} from '@htflow/replay';
import { pickSourceId } from '../modules/replay/logic';
import { registerFeedProvider } from './registry';
import { hub, paper } from '../state/market';
import { instrumentById } from '../state/instruments';

/**
 * Replay (P24 / P35). Instrument ids are `replay:<sourceInstrumentId>`. One replay session at a
 * time; it may hold several instruments on one clock (ReplayGroup). Every window on a replay
 * instrument shares the hub's store, which only this engine feeds — so charts, DOM, heatmap and
 * tape never see anything after the replay clock.
 */
export const REPLAY_PREFIX = 'replay:';
export const REPLAY_ACCOUNT = 'replay';

const fmtWhen = (t: number) => new Date(t).toLocaleString('en-GB');

export const isReplayId = (id: string) => id.startsWith(REPLAY_PREFIX);
export const replayIdOf = (sourceId: string) => REPLAY_PREFIX + sourceId;
export const sourceIdOf = (replayId: string) => replayId.slice(REPLAY_PREFIX.length);

export interface ReplayConfig {
  /** Source instrument ids (not `replay:`). */
  instruments: string[];
  from: number;
  to: number;
  layers: ReplayLayers & { hideFuture: boolean };
  /** Data source id ('tick-store', 'simulated', 'memory'); default: first that covers. */
  source?: string;
  /** Replay template this session was started from: its bookmarks and loop are saved back to it. */
  templateId?: string;
  /**
   * "History before start": bars / days loaded before `from` and drawn as normal bars, so the
   * chart has context and the newest replay bar sits at the right edge. Default 1 day.
   */
  lookback?: ReplayLookback;
  /** Bar length (ms) that turns a look-back in bars into time (the replay chart's timeframe). */
  lookbackBarMs?: number;
}

export interface ReplaySession {
  config: ReplayConfig;
  group: ReplayGroup;
  /** Engines by replay instrument id. */
  engines: Map<string, ReplayEngine>;
}

// ------------------------------------------------------------------ data sources

const sources: ReplayDataSource[] = [
  new SimulatedSource(),
  new MemorySource((id) => (isReplayId(id) ? undefined : hub.peek(id))),
];

/** The tick store (P06) registers here with the same interface; it is preferred when it covers. */
export function registerReplaySource(s: ReplayDataSource, preferred = true): void {
  const i = sources.findIndex((x) => x.id === s.id);
  if (i >= 0) sources.splice(i, 1);
  if (preferred) sources.unshift(s);
  else sources.push(s);
}

export function replaySources(instrumentId?: string): ReplayDataSource[] {
  return instrumentId ? sources.filter((s) => s.covers(instrumentId)) : sources;
}

/**
 * The source for [from, to]: the one the user chose, else the first (in preference order) whose
 * data covers the range — tick store, then simulator / session memory, then an exchange download —
 * else the one overlapping most. Without a range it is just the first that covers the instrument.
 */
export async function chooseSource(
  instrumentId: string,
  id?: string,
  from?: number,
  to?: number,
): Promise<ReplayDataSource> {
  const all = replaySources(instrumentId);
  const chosen = id ? all.find((x) => x.id === id) : undefined;
  if (chosen) return chosen;
  let pick: string | null = all[0]?.id ?? null;
  if (from !== undefined && to !== undefined && all.length > 1) {
    const ranges = await Promise.all(
      all.map(async (x) => ({ id: x.id, range: await x.range(instrumentId).catch(() => null) })),
    );
    pick = pickSourceId(ranges, from, to);
  }
  const s = all.find((x) => x.id === pick) ?? all[0];
  if (!s) throw new Error(`No recorded or downloadable data for ${instrumentId}`);
  return s;
}

// ------------------------------------------------------------------ session registry

let session: ReplaySession | null = null;
const scheduler = new ReplayScheduler({ tick: (dt) => session?.group.tick(dt) });
const listeners = new Set<() => void>();
const instruments = new Map<string, Instrument>();

export function replaySession(): ReplaySession | null {
  return session;
}

export function replayEngine(instrumentId: string): ReplayEngine | undefined {
  return session?.engines.get(instrumentId);
}

/** Notified when a session starts, stops or is replaced. */
export function onReplaySession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const l of listeners) l();
}

export function replayInstrument(sourceId: string): Instrument {
  const id = replayIdOf(sourceId);
  let inst = instruments.get(id);
  if (!inst) {
    const src =
      instrumentById(sourceId) ?? findMockInstrument(sourceId.replace(/^mock:/, ''))?.instrument;
    if (!src) throw new Error(`Unknown instrument ${sourceId}`);
    inst = { ...src, id, displayName: `${src.displayName} · Replay`, exchange: 'Replay' };
    instruments.set(id, inst);
  }
  return inst;
}

/** Loads data for every instrument and replaces the running session (paused at `from`). */
export async function startReplay(
  config: ReplayConfig,
  onProgress?: (p: number) => void,
): Promise<ReplaySession> {
  const engines = new Map<string, ReplayEngine>();
  const n = config.instruments.length;
  for (let i = 0; i < n; i++) {
    const src = config.instruments[i]!;
    const s = await chooseSource(src, config.source, config.from, config.to);
    const load = s.load.bind(s) as (
      id: string,
      from: number,
      to: number,
      l: ReplayLayers,
      p?: (x: number) => void,
    ) => Promise<Awaited<ReturnType<ReplayDataSource['load']>>>;
    // Main range first (0..70 %), then the look-back before it (70..100 %).
    const main = await load(src, config.from, config.to, config.layers, (p) =>
      onProgress?.((i + p * 0.7) / n),
    );
    const pre = await loadLookback(
      s,
      src,
      main.start,
      lookbackMs(config.lookback ?? DEFAULT_LOOKBACK, config.lookbackBarMs),
      (p) => onProgress?.((i + 0.7 + p * 0.3) / n),
    );
    const data = withLookback(main, pre);
    const rinst = replayInstrument(src);
    if (!main.trades.length)
      throw new Error(
        `No ticks for ${rinst.symbol} between ${fmtWhen(config.from)} and ${fmtWhen(config.to)} in "${s.label}". Pick a range the source covers (see "Available" in the setup).`,
      );
    engines.set(replayIdOf(src), new ReplayEngine(data));
  }
  const prev = session;
  const group = new ReplayGroup([...engines.values()]);
  // Same clock for every instrument: align to the latest start.
  const t0 = Math.max(...group.engines.map((e) => e.start));
  for (const e of group.engines) if (e.time < t0) e.advanceTo(t0);
  session = { config, group, engines };
  prev?.group.pause();
  scheduler.start();
  notify();
  return session;
}

/** "Hide future bars": on = nothing after the clock is drawn, off = future bars show as ghosts. */
export function hideFuture(): boolean {
  return session?.config.layers.hideFuture ?? true;
}

export function setHideFuture(on: boolean): void {
  if (!session || session.config.layers.hideFuture === on) return;
  session.config = { ...session.config, layers: { ...session.config.layers, hideFuture: on } };
  notify();
}

export function stopReplay(): void {
  session?.group.pause();
  session = null;
  scheduler.stop();
  notify();
}

// ------------------------------------------------------------------ feed

const DEFAULT_SPAN = 60 * 60_000;

class ReplayFeed implements FeedSource {
  readonly kind = 'replay' as const;
  readonly instrument: Instrument;
  private batchL = new Set<(b: EventBatch) => void>();
  private statusL = new Set<(s: FeedStatus) => void>();
  private detach: (() => void) | null = null;
  private engine: ReplayEngine | null = null;
  private unSession: () => void;
  private statusKey = '';

  constructor(readonly id: string) {
    this.instrument = replayInstrument(sourceIdOf(id));
    this.unSession = onReplaySession(() => this.attach(true));
  }

  async history(): Promise<HistoryData> {
    if (!replayEngine(this.id)) {
      // Restored workspace or picker: start a default session (last hour of data).
      const src = sourceIdOf(this.id);
      const probe = await chooseSource(src, undefined, Date.now() - DEFAULT_SPAN, Date.now());
      const range = await probe.range(src);
      if (!range) throw new Error(`No recorded data for ${src}`);
      const to = range.to;
      const from = Math.max(range.from, to - DEFAULT_SPAN);
      await startReplay({
        instruments: [src],
        from,
        to,
        layers: { ...DEFAULT_LAYERS, hideFuture: true },
      });
    }
    this.attach(false);
    return this.engine!.state();
  }

  /** (Re)binds to the session's engine for this instrument. */
  private attach(reload: boolean): void {
    const e = replayEngine(this.id) ?? null;
    if (e === this.engine) return;
    this.detach?.();
    this.detach = null;
    this.engine = e;
    if (!e) {
      this.emitStatus(true);
      return;
    }
    const store = () => hub.peek(this.id);
    const u1 = e.subscribe((b) => {
      for (const l of this.batchL) l(b);
    });
    const u2 = e.onReset(() => {
      const s = store();
      if (s?.ready) s.loadHistory(e.state());
    });
    const u3 = e.onChange(() => this.emitStatus());
    this.detach = () => (u1(), u2(), u3());
    if (reload) {
      const s = store();
      if (s?.ready) s.loadHistory(e.state());
    }
    this.emitStatus(true);
  }

  private status(): FeedStatus {
    const e = this.engine;
    return {
      state: e ? 'replay' : 'disconnected',
      latencyMs: 0,
      msgsPerSec: 0,
      message: e ? `${e.speed}× ${e.playing ? 'playing' : 'paused'}` : 'Replay stopped',
    };
  }

  private emitStatus(force = false): void {
    const s = this.status();
    const key = `${s.state}|${s.message}`;
    if (!force && key === this.statusKey) return;
    this.statusKey = key;
    for (const l of this.statusL) l(s);
  }

  subscribe(listener: (b: EventBatch) => void): () => void {
    this.batchL.add(listener);
    return () => this.batchL.delete(listener);
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    this.statusL.add(listener);
    listener(this.status());
    return () => this.statusL.delete(listener);
  }

  start(): void {}

  stop(): void {
    // Last window closed: pause this instrument, keep the session for the next window.
    this.engine?.pause();
    this.detach?.();
    this.detach = null;
    this.engine = null;
    this.unSession();
  }
}

registerFeedProvider({
  prefix: REPLAY_PREFIX,
  label: 'Replay',
  instruments: () => (session ? [...session.engines.keys()].map((id) => instruments.get(id)!) : []),
  create: (id) => new ReplayFeed(id),
});

// ------------------------------------------------------------------ replay account

if (!paper.accounts.has(REPLAY_ACCOUNT)) {
  paper.createAccount({
    id: REPLAY_ACCOUNT,
    name: 'Replay · paper',
    kind: 'replay',
    startingBalance: 50_000,
    commissionPerUnit: 0,
  });
}
// Orders and fills on replay instruments are stamped with the replay clock, not wall time.
paper.setClock((id) => (isReplayId(id) ? replayEngine(id)?.time : undefined));
// Orders on replay instruments always trade the replay account and are tagged #replay.
paper.setAccountRouter((_acc, instrumentId) =>
  isReplayId(instrumentId) ? { accountId: REPLAY_ACCOUNT, tag: 'replay' } : undefined,
);
