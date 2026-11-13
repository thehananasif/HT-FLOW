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
