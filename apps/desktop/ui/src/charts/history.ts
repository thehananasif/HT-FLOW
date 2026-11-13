/** "Load days" (P31): how much history a chart wants, and what is still missing. */

export const DAY_MS = 86_400_000;
export const MIN_LOAD_DAYS = 1;
export const MAX_LOAD_DAYS = 365;

function clampDays(n: number): number {
  return Math.min(MAX_LOAD_DAYS, Math.max(MIN_LOAD_DAYS, Math.round(n)));
}

/** Whole days in [1, 365]; anything unreadable falls back to `fallback`. */
export function normalizeLoadDays(v: unknown, fallback = 4): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return clampDays(fallback);
  return clampDays(n);
}

/** History (ms) still to load so [first, last] covers `days` days; 0 when covered or empty. */
export function missingHistoryMs(
  firstTs: number | undefined,
  lastTs: number,
  days: number,
): number {
  if (firstTs === undefined || !Number.isFinite(firstTs) || lastTs <= 0) return 0;
  return Math.max(0, days * DAY_MS - Math.max(0, lastTs - firstTs));
}

/**
 * Spans (ms, newest first) to request for the missing history: whole days, the last one shorter.
 * Bounded to `maxChunks` so a bad clock never loops forever.
 */
export function loadChunks(
  missingMs: number,
  chunkMs = DAY_MS,
  maxChunks = MAX_LOAD_DAYS,
): number[] {
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
 * Whether a chart loads the missing days by itself when it opens. Simulated feeds generate older
 * history on demand only (a simulated day is ~700k ticks): "◂ Load 1 more day" extends them.
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

/** Bars a time-based chart shows at least once it has opened (long timeframes load more days). */
export const MIN_OPEN_BARS = 120;

/**
 * Spans (ms, newest first) a chart loads when it opens: the missing part of `days` in whole
 * days, then one more span so a time-based chart of `periodMs` bars shows at least
 * {@link MIN_OPEN_BARS} bars (a 4h / 1D chart). One span for the extra part keeps it to one
 * request: the desktop backfill picks a kline interval to match, so it stays cheap.
 */
export function openLoadChunks(
  firstTs: number | undefined,
  lastTs: number,
  days: number,
  periodMs?: number,
): number[] {
  const chunks = loadChunks(missingHistoryMs(firstTs, lastTs, days));
  if (!periodMs || periodMs <= 0 || firstTs === undefined || lastTs <= 0) return chunks;
  const planned = Math.max(0, lastTs - firstTs) + chunks.reduce((a, b) => a + b, 0);
  const want = Math.min(periodMs * MIN_OPEN_BARS, MAX_LOAD_DAYS * DAY_MS);
  if (want > planned) chunks.push(want - planned);
  return chunks;
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
