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
