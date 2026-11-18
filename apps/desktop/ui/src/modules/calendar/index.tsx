import { Fragment, useState } from 'react';
import { Badge, Button, Checkbox, Chip, Input, NumberInput } from '@htflow/ui-kit';
import {
  formatCountdown,
  groupByDay,
  nextHighImpact,
  passesImpact,
  surprise,
  timeLabel,
  utcOffsetLabel,
  type ImpactFilter,
} from '@htflow/info';
import { registerModule } from '../registry';
import { useStore, useTick, useCalendarTimezone } from '../rss/shared';
import { addSource, allEvents, calendar, refreshCalendars, usingSample } from './store';
import './chartLines';
import '../rss/styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
const DOTS = { high: '●●●', medium: '●●○', low: '●○○' } as const;

function EconomicCalendar() {
  const s = useStore(calendar);
  useTick(1000);
  const tz = useCalendarTimezone();
  const now = Date.now();
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const events = allEvents(s, now).filter((e) => passesImpact(e, s.impact));
  const next = nextHighImpact(allEvents(s, now), now);
  const set = (p: Partial<typeof s>) => calendar.set({ ...calendar.get(), ...p });
  const hasSample = events.some((e) => e.sample);
  const [busy, setBusy] = useState(false);
  const status = !s.publicOn
    ? 'Public calendar off'
    : busy
      ? 'Loading…'
      : s.pub.error
        ? s.pub.events.length
          ? `Offline — cached calendar shown (${s.pub.error})`
          : `Calendar unavailable: ${s.pub.error}`
        : s.pub.fetchedAt
          ? `Updated ${timeLabel(s.pub.fetchedAt, tz)}`
          : 'Loading…';

  return (
    <div className="module-window" data-testid="economic-calendar">
      <div className="info-toolbar">
        <b>{tl('Economic calendar')}</b>
        <span className="muted">
          {tl('times in')} {tz} ({utcOffsetLabel(now, tz)})
        </span>
        <span className="grow" />
        <span
          className={s.pub.error ? 'down' : 'muted'}
          data-testid="calendar-status"
          title={s.pub.error}
        >
          {status}
        </span>
        <Button
          size="sm"
          disabled={busy || !s.publicOn}
          onClick={() => {
            setBusy(true);
            void refreshCalendars(true).finally(() => setBusy(false));
          }}
        >
          {tl('Refresh')}
        </Button>
        {next && (
          <span className="cal-countdown tnum" title={`${next.currency} ${next.title}`}>
            {tl('Next high impact in')} {formatCountdown(next.t - now)}
          </span>
        )}
      </div>
      <div className="info-toolbar">
        {(['all', 'medium', 'high'] as ImpactFilter[]).map((f) => (
          <Chip key={f} selected={s.impact === f} onClick={() => set({ impact: f })}>
            {f === 'all' ? 'All impact' : f === 'medium' ? 'Medium+' : 'High+'}
          </Chip>
        ))}
        <span className="grow" />
        <Checkbox
          checked={s.showOnCharts}
          onChange={(v) => set({ showOnCharts: v })}
          label={tl('Show as lines on charts')}
        />
        <Checkbox checked={s.alertOn} onChange={(v) => set({ alertOn: v })} label={tl('Alert')} />
        <NumberInput
          aria-label={tl('Alert minutes before')}
          value={s.alertMinutes}
          min={0}
          max={240}
          step={1}
          unit="min before"
          onChange={(v) => set({ alertMinutes: v })}
        />
        <Button size="sm" onClick={() => setShowSources((x) => !x)}>
          {tl('ICS sources (')}
          {s.sources.length})
        </Button>
      </div>
      {showSources && (
        <div className="info-toolbar" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
          <div className="row gap8 center-y" style={{ width: '100%' }}>
            <Input
              style={{ flex: 1 }}
              placeholder={tl('https://…/calendar.ics (public iCalendar feed)')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const e = addSource(url);
                setErr(e);
                if (!e) setUrl('');
              }}
            >
              {tl('Add ICS URL')}
            </Button>
            <Checkbox
              checked={s.publicOn}
              onChange={(v) => {
                set({ publicOn: v });
                if (v) void refreshCalendars();
              }}
              label={tl('Public economic calendar')}
            />
            <Checkbox
              checked={s.showSample}
              onChange={(v) => set({ showSample: v })}
              label={tl('Sample events when offline with no cache')}
            />
          </div>
          {err && <span className="down">{err}</span>}
          {s.sources.map((src) => (
            <div key={src.id} className="row gap8 center-y" style={{ width: '100%' }}>
              <Checkbox
                checked={src.enabled}
                onChange={(v) =>
                  set({
                    sources: s.sources.map((x) => (x.id === src.id ? { ...x, enabled: v } : x)),
                  })
                }
                label={src.name || src.url}
              />
              <span className="muted grow ellipsis">
                {src.lastError
                  ? `Error: ${src.lastError} — cached events shown`
                  : `${s.cache[src.id]?.length ?? 0} events`}
              </span>
              <button
                className="link"
                onClick={() => {
                  const cache = { ...s.cache };
                  delete cache[src.id];
                  set({ sources: s.sources.filter((x) => x.id !== src.id), cache });
                }}
              >
                {tl('Remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="tbl-wrap">
        <table className="tbl tnum cal-table">
          <thead>
            <tr>
              <th>{tl('Time')}</th>
              <th>{tl('Cur')}</th>
              <th>{tl('Impact')}</th>
              <th>{tl('Event')}</th>
              <th className="cal-num">{tl('Actual')}</th>
              <th className="cal-num">{tl('Forecast')}</th>
              <th className="cal-num">{tl('Previous')}</th>
            </tr>
          </thead>
          <tbody>
            {groupByDay(events, tz).map((g) => (
              <Fragment key={g.key}>
                <tr className="cal-day">
                  <td colSpan={7}>{tl(g.label)}</td>
                </tr>
                {g.events.map((e) => {
                  const sp = surprise(e);
                  return (
                    <tr
                      key={`${e.sourceId}:${e.uid}@${e.t}`}
                      className={
                        next && e.uid === next.uid && e.t === next.t
                          ? 'cal-next'
                          : e.t < now
                            ? 'cal-past'
                            : undefined
                      }
                      title={e.description || undefined}
                    >
                      <td>{e.allDay ? 'All day' : timeLabel(e.t, tz)}</td>
                      <td>
                        <b>{e.currency || '—'}</b>
                      </td>
                      <td>
                        <span
                          className="impact-dots"
                          data-impact={e.impact}
                          aria-label={`${e.impact} impact`}
                        >
                          {DOTS[e.impact]}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {tl(e.title)}
                        {e.sample && (
                          <>
                            {' '}
                            <Badge kind="delayed">{tl('sample')}</Badge>
                          </>
                        )}
                      </td>
                      <td className={`cal-num ${sp ?? ''}`}>{e.actual ?? '—'}</td>
                      <td className="cal-num">{e.forecast ?? ''}</td>
                      <td className="cal-num">{e.previous ?? ''}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!events.length && <div className="tbl-empty">{tl('No events for this filter')}</div>}
      </div>
      <div className="info-foot">
        {tl('Source: Public economic calendar (weekly) · ICS feeds you add')}
        {usingSample(s) &&
          hasSample &&
          ' · OFFLINE SAMPLE events shown: no real calendar data yet (times and values are not real releases)'}
      </div>
    </div>
  );
}

registerModule({ id: 'calendar', view: EconomicCalendar });
