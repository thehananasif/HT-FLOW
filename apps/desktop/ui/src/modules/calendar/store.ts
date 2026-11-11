import { toast } from '@htflow/ui-kit';
import {
  dueAlerts,
  isHttpUrl,
  mergeEvents,
  parseIcs,
  sampleCalendarIcs,
  timeLabel,
  type CalendarEvent,
  type ImpactFilter,
} from '@htflow/info';
import { fetchText, PersistedStore, userTimezone } from '../rss/shared';

export interface IcsSource {
  id: string;
  url: string;
  enabled: boolean;
  name?: string;
  lastFetched?: number;
  lastError?: string;
}

/** An event plus where it came from (sample events are never presented as real). */
export interface CalEvent extends CalendarEvent {
  sourceId: string;
  sample: boolean;
}

export interface CalendarSettings {
  version: 1;
  sources: IcsSource[];
  /** Offline cache of fetched events per source id. */
  cache: Record<string, CalendarEvent[]>;
  showSample: boolean;
  impact: ImpactFilter;
  showOnCharts: boolean;
  chartImpact: ImpactFilter;
  alertOn: boolean;
  alertMinutes: number;
  alertImpact: ImpactFilter;
}

const IMPACTS: ImpactFilter[] = ['all', 'medium', 'high'];

export function defaultCalendar(): CalendarSettings {
  return {
    version: 1,
    sources: [],
    cache: {},
    showSample: true,
    impact: 'all',
    showOnCharts: true,
    chartImpact: 'medium',
    alertOn: true,
    alertMinutes: 5,
    alertImpact: 'high',
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

export function normalizeCalendar(raw: unknown): CalendarSettings {
  const d = defaultCalendar();
  if (!isObj(raw)) return d;
  const imp = (v: unknown, def: ImpactFilter) => (IMPACTS.includes(v as ImpactFilter) ? (v as ImpactFilter) : def);
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter(
        (s): s is IcsSource => isObj(s) && typeof s.id === 'string' && typeof s.url === 'string' && isHttpUrl(s.url),
      )
    : [];
  const cache: Record<string, CalendarEvent[]> = {};
  if (isObj(raw.cache))
    for (const s of sources) {
      const list = raw.cache[s.id];
      if (Array.isArray(list))
        cache[s.id] = list.filter((e): e is CalendarEvent => isObj(e) && typeof e.t === 'number' && typeof e.title === 'string');
    }
  const m = Number(raw.alertMinutes);
  return {
    version: 1,
    sources: sources.map((s) => ({ ...s, enabled: s.enabled !== false })),
    cache,
    showSample: raw.showSample !== false,
    impact: imp(raw.impact, d.impact),
    showOnCharts: raw.showOnCharts !== false,
    chartImpact: imp(raw.chartImpact, d.chartImpact),
    alertOn: raw.alertOn !== false,
    alertMinutes: Number.isFinite(m) && m >= 0 && m <= 240 ? Math.round(m) : d.alertMinutes,
    alertImpact: imp(raw.alertImpact, d.alertImpact),
  };
}

export const calendar = new PersistedStore<CalendarSettings>('calendar', defaultCalendar, normalizeCalendar, () =>
  void refreshCalendars(),
);

let sampleCache: { hour: number; events: CalEvent[] } | null = null;
function sampleEvents(now: number): CalEvent[] {
  const hour = Math.floor(now / 3_600_000);
  if (sampleCache?.hour !== hour)
    sampleCache = {
      hour,
      events: parseIcs(sampleCalendarIcs(now)).events.map((e) => ({ ...e, sourceId: 'sample', sample: true })),
    };
  return sampleCache.events;
}

/** All events: user ICS sources (cached) + the bundled SAMPLE set when enabled or nothing else exists. */
export function allEvents(s: CalendarSettings = calendar.get(), now = Date.now()): CalEvent[] {
  const real = s.sources
    .filter((x) => x.enabled)
    .map((x) => (s.cache[x.id] ?? []).map((e) => ({ ...e, sourceId: x.id, sample: false })));
  const hasReal = real.some((l) => l.length);
  return mergeEvents([...real, ...(s.showSample || !hasReal ? [sampleEvents(now)] : [])]);
}

export async function refreshSource(id: string): Promise<void> {
  const src = calendar.get().sources.find((s) => s.id === id);
  if (!src) return;
  const patch = (p: Partial<IcsSource>, events?: CalendarEvent[]) =>
    calendar.update((s) => ({
      ...s,
      sources: s.sources.map((x) => (x.id === id ? { ...x, ...p } : x)),
      cache: events ? { ...s.cache, [id]: events } : s.cache,
    }));
  try {
    const r = parseIcs(await fetchText(src.url), { defaultTz: 'UTC' });
    patch({ lastFetched: Date.now(), lastError: r.events.length ? undefined : 'No events in calendar', name: r.calendarName || src.name }, r.events);
  } catch (e) {
    patch({ lastFetched: Date.now(), lastError: e instanceof Error ? e.message : String(e) });
  }
}

export async function refreshCalendars(): Promise<void> {
  await Promise.all(calendar.get().sources.filter((s) => s.enabled).map((s) => refreshSource(s.id)));
}

export function addSource(url: string): string | null {
  if (!isHttpUrl(url)) return 'Enter an http:// or https:// .ics URL';
  const s = calendar.get();
  if (s.sources.some((x) => x.url === url.trim())) return 'Already added';
  const id = `c${Date.now().toString(36)}`;
  calendar.set({ ...s, sources: [...s.sources, { id, url: url.trim(), enabled: true }] });
  void refreshSource(id);
  return null;
}

// "Alert N min before" — runs once the profile's calendar settings are loaded.
const fired = new Set<string>();
setInterval(() => {
  if (!calendar.loaded) return;
  const s = calendar.get();
  if (!s.alertOn) return;
  for (const e of dueAlerts(allEvents(s), Date.now(), s.alertMinutes, s.alertImpact, fired)) {
    toast(
      'warning',
      `${e.currency} ${e.title} in ${Math.max(1, Math.round((e.t - Date.now()) / 60_000))} min`,
      `${timeLabel(e.t, userTimezone())} · ${e.impact} impact${e.sample ? ' · SAMPLE event, not a real release' : ''}`,
      8000,
    );
  }
}, 15_000);
