/**
 * Chart history (round 7): no "Load days" any more. A chart paints the most recent window at
 * once, then backfills older history automatically in the background as far back as the venue
 * provides (bounded by Settings → Common → Max candles per chart), and keeps loading when the
 * user scrolls left (gated by {@link LazyHistoryGate}).
 */

export const DAY_MS = 86_400_000;

/**
 * Spans (ms, newest first) to request for the missing history: whole days, the last one shorter.
 * Bounded to `maxChunks` so a bad clock never loops forever.
 */
export function loadChunks(missingMs: number, chunkMs = DAY_MS, maxChunks = 365): number[] {
  const out: number[] = [];
  let left = Math.max(0, missingMs);
  while (left > 0 && out.length < maxChunks) {
    const c = Math.min(chunkMs, left);
    out.push(c);
    left -= c;
  }
  return out;
}

/**
 * Whether a chart backfills older history by itself. Simulated feeds generate older history on
 * demand only (a simulated day is ~700k ticks): scrolling left extends them.
 */
export function autoLoadsHistory(feedKind: string | null, hasOlderLoader: boolean): boolean {
  return hasOlderLoader && feedKind !== 'mock';
}

/** "2.3 d" / "6 h" / "45 min" for the loaded range label. */
export function spanLabel(ms: number): string {
  if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(ms >= 10 * DAY_MS ? 0 : 1)} d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.max(0, Math.round(ms / 60_000))} min`;
}

/** Bars the first background step fills (a 4 h / 1 D chart has a full screen right away). */
export const MIN_OPEN_BARS = 120;
/** Bars of the chart period one later background step asks for (≤ every venue's kline budget, so
 * the backfill keeps the chart's own bar resolution). */
export const BACKFILL_BARS_PER_STEP = 3000;
/** Longest span of one step (the native range command accepts 400 days). */
export const MAX_BACKFILL_SPAN_MS = 365 * DAY_MS;
/** Loop protection: steps one background backfill may take, whatever the feed answers. */
export const MAX_BACKFILL_STEPS = 400;
/** Real-trade REST budget of the first step: fills the screen fast; later steps use the default. */
export const FIRST_STEP_PAGES = 12;

/** Span (ms) of background backfill step `step` for a chart of `periodMs` bars (null = tick /
 * volume / range bars). */
export function backfillSpanMs(periodMs: number | null | undefined, step: number): number {
  const p = periodMs && periodMs > 0 ? periodMs : null;
  if (!p) return step === 0 ? 3_600_000 : 6 * 3_600_000;
  const bars = step === 0 ? MIN_OPEN_BARS : BACKFILL_BARS_PER_STEP;
  return Math.min(MAX_BACKFILL_SPAN_MS, Math.max(3_600_000, p * bars));
}

export interface BackfillDeps {
  periodMs: number | null | undefined;
  /** Bars the chart shows now. */
  bars(): number;
  maxBars: number;
  /** Loads `spanMs` before the first trade; resolves to the trades added (0 = start reached). */
  loadOlder(spanMs: number, opts?: { maxPages?: number }): Promise<number>;
  /** Another request (left-scroll) is in flight. */
  busy(): boolean;
  exhausted(): boolean;
  stopped(): boolean;
  onStep?(step: number, added: number): void;
  /** Yields to the UI between steps (default: a macrotask). */
  pause?(ms: number): Promise<void>;
}

export type BackfillEnd = 'exhausted' | 'max-candles' | 'stopped' | 'step-cap';

/**
 * The automatic all-history backfill loop. Every step yields to the UI thread first; it stops at
 * the start of the venue's history, at the max-candles cap, when the chart is rebuilt, or after
 * {@link MAX_BACKFILL_STEPS} — it can never spin (the old 4 h freeze).
 */
export async function runBackfill(d: BackfillDeps): Promise<{ steps: number; end: BackfillEnd }> {
  const pause = d.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let step = 0;
  let waits = 0;
  while (step < MAX_BACKFILL_STEPS) {
    await pause(step === 0 ? 0 : 16);
    if (d.stopped()) return { steps: step, end: 'stopped' };
    if (d.exhausted()) return { steps: step, end: 'exhausted' };
    if (d.bars() >= d.maxBars) return { steps: step, end: 'max-candles' };
    if (d.busy()) {
      // A left-scroll request is running: wait for it (bounded) instead of stopping.
      if (++waits > 600) return { steps: step, end: 'step-cap' };
      await pause(250);
      continue;
    }
    const added = await d.loadOlder(
      backfillSpanMs(d.periodMs, step),
      step === 0 ? { maxPages: FIRST_STEP_PAGES } : undefined,
    );
    d.onStep?.(step, added);
    step++;
    if (!added) return { steps: step, end: d.stopped() ? 'stopped' : 'exhausted' };
  }
  return { steps: step, end: 'step-cap' };
}

export interface HistoryProgressLike {
  doneMs: number;
  totalMs: number;
  trades: number;
  phase: 'trades' | 'klines' | 'done';
  throttled: boolean;
}

/** "Downloading ticks 45 % · 120,000 ticks · rate limited, slowing down" for the chart footer. */
export function progressLabel(p: HistoryProgressLike): string {
  const pct = p.totalMs > 0 ? Math.round((100 * Math.min(p.doneMs, p.totalMs)) / p.totalMs) : 0;
  const what =
    p.phase === 'klines'
      ? 'Loading bar history'
      : p.phase === 'done'
        ? 'History loaded'
        : 'Downloading ticks';
  const parts = [`${what} ${pct} %`, `${p.trades.toLocaleString('en-US')} ticks`];
  if (p.throttled) parts.push('rate limited, slowing down');
  return parts.join(' · ');
}

/** Largest older-history chunk one lazy left-scroll request may ask for, per feed kind. */
export const LAZY_SPAN_CAP_MS: Record<'mock' | 'live' | 'replay', number> = {
  // A simulated hour is ~30k ticks generated on the main thread: keep each step small.
  mock: 2 * 3_600_000,
  live: DAY_MS,
  replay: DAY_MS,
};

/**
 * Span (ms) of one lazy left-scroll request: about 240 bars of the chart's period, at least one
 * hour, capped per feed kind. Coarse timeframes used to ask for 240 × 4 h = 40 days at once.
 */
export function lazySpanMs(periodMs: number | null, feedKind: string | null): number {
  const want = Math.max(3_600_000, (periodMs && periodMs > 0 ? periodMs : 60_000) * 240);
  const cap =
    feedKind === 'mock' || feedKind === 'live' || feedKind === 'replay'
      ? LAZY_SPAN_CAP_MS[feedKind]
      : DAY_MS;
  return Math.min(want, cap);
}

/**
 * Decides when "scrolled past the first bar" may request older history. The chart reports it on
 * every draw, so with few bars (4 h, 1 D, 1 W) the view is always past the start: without a gate
 * each loaded chunk triggered the next one forever. A request is allowed only after the user has
 * scrolled the view since the chart opened or since the previous request.
 */
export class LazyHistoryGate {
  private lastOffset: number;
  private disposed = false;

  constructor(initialOffset: number) {
    this.lastOffset = initialOffset;
  }

  /** True when a request may start for the current scroll offset; records it. */
  take(offset: number): boolean {
    if (this.disposed || !Number.isFinite(offset)) return false;
    if (Math.abs(offset - this.lastOffset) < 0.5) return false;
    this.lastOffset = offset;
    return true;
  }

  /** The chart was rebuilt (timeframe change): pending results must not touch it. */
  dispose(): void {
    this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
