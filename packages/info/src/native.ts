/** Normalisers for the typed payloads of the native `feed_fetch` / `calendar_fetch` commands. */
import { itemKey, safeLink, type FeedItem } from './feed';
import type { CalendarEvent, Impact } from './ics';
import { hashString, truncate } from './text';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Items of a native feed result → FeedItems (untrusted: re-validated, links re-checked). */
export function nativeItemsToFeedItems(raw: unknown): FeedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedItem[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const title = truncate(str(r.title).trim(), 400);
    const link = safeLink(str(r.link));
    if (!title && !link) continue;
    const published =
      typeof r.published === 'number' && Number.isFinite(r.published) ? r.published : null;
    const guid = optStr(r.guid);
    const finalTitle = title || '(untitled)';
    out.push({
      id: itemKey({ guid, link, title: finalTitle, published }),
      guid,
      link,
      title: finalTitle,
      summary: truncate(str(r.summary).trim(), 1200),
      published,
      author: optStr(r.author),
      categories: Array.isArray(r.categories)
        ? r.categories.filter((c): c is string => typeof c === 'string').slice(0, 8)
        : [],
    });
  }
  return out;
}

const IMPACTS: Impact[] = ['low', 'medium', 'high'];

/** Events of a native calendar result → CalendarEvents (UTC epoch ms, stable uid). */
export function nativeEventsToCalendar(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEvent[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.t !== 'number' || !Number.isFinite(r.t)) continue;
    const title = str(r.title).trim();
    if (!title) continue;
    const currency = /^[A-Za-z]{2,4}$/.test(str(r.currency)) ? str(r.currency).toUpperCase() : '';
    const impact = IMPACTS.includes(r.impact as Impact) ? (r.impact as Impact) : 'low';
    out.push({
      uid: `pub-${hashString(`${currency}|${title}|${r.t}`)}`,
      t: r.t,
      allDay: false,
      title,
      description: '',
      currency,
      impact,
      actual: optStr(r.actual),
      forecast: optStr(r.forecast),
      previous: optStr(r.previous),
      categories: [],
    });
  }
  return out.sort((a, b) => a.t - b.t);
}
