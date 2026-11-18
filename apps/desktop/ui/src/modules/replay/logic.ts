import { currencyAffects, instrumentRoot, passesImpact, type ImpactFilter } from '@htflow/info';
import type { Fill } from '@htflow/trading';
import type { ReplayBookmark } from '@htflow/replay';

/** Pure replay-display logic: persisted display options, timeline events, fill tags, bookmarks. */

export interface ReplayDisplay {
  /** Number of faded future bars drawn when "Hide future bars" is off (5..300). */
  ghostBars: number;
  /** Ghost candle opacity 0.1..0.9. */
  ghostOpacity: number;
  /** B / S fill tags on bars. */
  fillTags: boolean;
  /** Tag font size (8..16). */
  tagSize: number;
  /** Include the filled quantity in the tag ("B 2"). */
  tagQty: boolean;
  /** Economic-event markers on the timeline. */
  timelineEvents: boolean;
  /** Minimum impact of the timeline markers. */
  eventImpact: ImpactFilter;
}

export const DEFAULT_DISPLAY: ReplayDisplay = {
  ghostBars: 60,
  ghostOpacity: 0.35,
  fillTags: true,
  tagSize: 10,
  tagQty: true,
  timelineEvents: true,
  eventImpact: 'medium',
};

const clamp = (v: unknown, lo: number, hi: number, f: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f;
const bool = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);

export function normalizeDisplay(raw: unknown): ReplayDisplay {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DISPLAY;
  return {
    ghostBars: Math.round(clamp(r.ghostBars, 5, 300, d.ghostBars)),
    ghostOpacity: clamp(r.ghostOpacity, 0.1, 0.9, d.ghostOpacity),
    fillTags: bool(r.fillTags, d.fillTags),
    tagSize: Math.round(clamp(r.tagSize, 8, 16, d.tagSize)),
    tagQty: bool(r.tagQty, d.tagQty),
    timelineEvents: bool(r.timelineEvents, d.timelineEvents),
    eventImpact:
      r.eventImpact === 'all' || r.eventImpact === 'high' || r.eventImpact === 'medium'
        ? r.eventImpact
        : d.eventImpact,
  };
}

// ------------------------------------------------------------------ timeline events

export interface TimelineEvent {
  uid: string;
  t: number;
  title: string;
  currency: string;
  impact: 'low' | 'medium' | 'high';
}

interface EventLike {
  uid: string;
  t: number;
  title: string;
  currency: string;
  impact: 'low' | 'medium' | 'high';
  allDay: boolean;
}

/** Calendar events inside the replay range that move this instrument and pass the impact filter. */
export function timelineEvents(
  events: readonly EventLike[],
  start: number,
  end: number,
  inst: { symbol: string; assetClass: string },
  impact: ImpactFilter,
): TimelineEvent[] {
  const root = instrumentRoot(inst.symbol);
  return events
    .filter(
      (e) =>
        !e.allDay &&
        e.t >= start &&
        e.t <= end &&
        passesImpact(e, impact) &&
        (!e.currency || currencyAffects(e.currency, root, inst.assetClass)),
    )
    .map((e) => ({ uid: e.uid, t: e.t, title: e.title, currency: e.currency, impact: e.impact }))
    .sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ fill tags

export interface FillTag {
  id: string;
  ts: number;
  px: number;
  side: 'buy' | 'sell';
  qty: number;
  text: string;
}

/** B / S tags for the replay fills of one instrument up to the replay clock (never future fills). */
export function fillTags(
  fills: readonly Fill[],
  instrumentId: string,
  now: number,
  showQty = true,
): FillTag[] {
  return fills
    .filter((f) => f.instrumentId === instrumentId && f.tag === 'replay' && f.ts <= now)
    .map((f) => ({
      id: f.id,
      ts: f.ts,
      px: f.px,
      side: f.side,
      qty: f.qty,
      text: `${f.side === 'buy' ? 'B' : 'S'}${showQty ? ` ${f.qty}` : ''}`,
    }));
}

// ------------------------------------------------------------------ bookmarks / loop per template

export interface SavedBookmark {
  t: number;
  label: string;
}

export interface SavedReplayState {
  bookmarks: SavedBookmark[];
  loop: { from: number; to: number } | null;
}

/** Validates persisted bookmarks and keeps those inside [start, end]. */
export function normalizeBookmarks(raw: unknown, start: number, end: number): SavedBookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedBookmark[] = [];
  for (const b of raw) {
    const o = b as Partial<SavedBookmark> | null;
    if (!o || typeof o.t !== 'number' || !Number.isFinite(o.t)) continue;
    if (o.t < start || o.t > end) continue;
    out.push({ t: o.t, label: typeof o.label === 'string' && o.label ? o.label : 'Bookmark' });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function normalizeLoop(
  raw: unknown,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const o = raw as { from?: unknown; to?: unknown } | null;
  if (!o || typeof o.from !== 'number' || typeof o.to !== 'number') return null;
  const from = Math.max(start, o.from);
  const to = Math.min(end, o.to);
  return to > from ? { from, to } : null;
}

export function savedStateOf(
  bookmarks: readonly Pick<ReplayBookmark, 't' | 'label'>[],
  loop: { from: number; to: number } | null,
): SavedReplayState {
  return {
    bookmarks: bookmarks.map((b) => ({ t: b.t, label: b.label })).sort((a, b) => a.t - b.t),
    loop: loop ? { from: loop.from, to: loop.to } : null,
  };
}

export function sameSavedState(a: SavedReplayState, b: SavedReplayState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------ setup validation

/** Largest range (bytes, estimated) one session may load: keeps the UI thread and memory sane. */
export const MAX_SESSION_BYTES = 600e6;
/** `to` may be this far ahead of the wall clock (the setup rounds "now" to the minute). */
const FUTURE_SLACK_MS = 2 * 60_000;

/** Why a replay range cannot be started, or null when it is fine. */
export function validateRange(
  from: number,
  to: number,
  now: number,
  estimatedBytes = 0,
): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Pick a start and an end time';
  if (!(to > from)) return 'To must be after From';
  if (to > now + FUTURE_SLACK_MS) return 'To is in the future: there is nothing to replay yet';
  if (estimatedBytes > MAX_SESSION_BYTES)
    return `That range is about ${Math.round(estimatedBytes / 1e6)} MB: shorten it (max ${Math.round(MAX_SESSION_BYTES / 1e6)} MB)`;
  return null;
}

export interface SourceRange {
  id: string;
  /** Available data range of the source for the instrument, or null when unknown / empty. */
  range: { from: number; to: number } | null;
}

/**
 * Picks the data source for [from, to] from candidates in preference order: the first one whose
 * range covers the request (within `tolMs`), else the one overlapping most, else the first
 * candidate (so generated sources that have no meaningful range still work). null: no candidates.
 */
export function pickSourceId(
  candidates: readonly SourceRange[],
  from: number,
  to: number,
  tolMs = 120_000,
): string | null {
  if (!candidates.length) return null;
  let best: { id: string; overlap: number } | null = null;
  for (const c of candidates) {
    const r = c.range;
    if (!r) continue;
    if (r.from <= from + tolMs && r.to >= to - tolMs) return c.id;
    const overlap = Math.min(to, r.to) - Math.max(from, r.from);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: c.id, overlap };
  }
  return best?.id ?? candidates[0]!.id;
}

// ------------------------------------------------------------------ leaving replay

const REPLAY_PREFIX = 'replay:';

/** Windows (id → instrument id) that show a replay instrument, with the live instrument to go back to. */
export function exitReplayTargets(
  windows: Readonly<Record<string, string | undefined>>,
): { id: string; instrumentId: string }[] {
  const out: { id: string; instrumentId: string }[] = [];
  for (const [id, inst] of Object.entries(windows))
    if (inst && inst.startsWith(REPLAY_PREFIX))
      out.push({ id, instrumentId: inst.slice(REPLAY_PREFIX.length) });
  return out;
}

// ------------------------------------------------------------------ timeline

/** CSS left / width (percent strings) of the loop band on the timeline. */
export function loopBand(
  loop: { from: number; to: number },
  start: number,
  end: number,
): { left: string; width: string } {
  const span = Math.max(1, end - start);
  const l = Math.min(1, Math.max(0, (loop.from - start) / span));
  const r = Math.min(1, Math.max(l, (loop.to - start) / span));
  return { left: `${(l * 100).toFixed(3)}%`, width: `${((r - l) * 100).toFixed(3)}%` };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Timeline end label: "HH:MM", with the day ("05 Jan 14:30") when the range is a day or longer. */
export function edgeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (spanMs < 86_400_000) return hm;
  return `${p2(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'short' })} ${hm}`;
}
