import type { NewsEvent } from '@htflow/trading';

/** Minimal calendar event shape (Economic Calendar `CalEvent`). */
export interface NewsSourceEvent {
  t: number;
  title: string;
  currency: string;
  impact: 'low' | 'medium' | 'high' | string;
  allDay: boolean;
  sample: boolean;
}

/**
 * High-impact Economic Calendar events → risk-engine news events (P23 news-flatten). All-day
 * entries (holidays) are skipped; SAMPLE events count only when `includeSample` is on, so the
 * bundled demo calendar never flattens a position unless the user asks it to. Only events from
 * an hour ago to `horizonMs` ahead are kept.
 */
export function newsFromCalendar(
  events: readonly NewsSourceEvent[],
  now: number,
  opts: { includeSample: boolean; horizonMs?: number },
): NewsEvent[] {
  const horizon = opts.horizonMs ?? 7 * 86_400_000;
  return events
    .filter(
      (e) =>
        e.impact === 'high' &&
        !e.allDay &&
        (opts.includeSample || !e.sample) &&
        e.t > now - 3_600_000 &&
        e.t <= now + horizon,
    )
    .map((e) => ({
      ts: e.t,
      title: `${e.currency ? e.currency + ' ' : ''}${e.title}${e.sample ? ' (SAMPLE)' : ''}`,
    }))
    .sort((a, b) => a.ts - b.ts);
}
