import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Field, Input, toast } from '@htflow/ui-kit';
import { formatPrice } from '@htflow/market-data';
import {
  dailyPnl,
  equityCurve,
  excursion,
  journalStats,
  localDayKey,
  netOf,
  periodStart,
  rMultiple,
  type EquityPoint,
  type JournalPeriod,
  type RoundTrip,
} from '@htflow/trading';
import { hub, paper, pnlTick } from '../../state/market';
import { allInstruments, instrumentById } from '../../state/instruments';
import { downloadText, toCsv } from '../../components/DataTable.utils';
import { registerModule } from '../registry';
import {
  exchangeTimeTitle,
  fmtClock,
  fmtDate,
  formatNumber,
  HIDDEN_MONEY,
  privacyOptions,
  usePrivacy,
  useTimeFormat,
} from '../../state/format';
import { useSetting } from '../../state/settings';
import { journalStore, type JournalTag, type TagKind } from './store';
import './styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
const PERIODS: { id: JournalPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All' },
];
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const money = (v: number, digits = 0) => {
  const o = privacyOptions();
  if (o.hide) return HIDDEN_MONEY;
  return (v < 0 ? '−$' : '$') + formatNumber(Math.abs(v), o.locale, digits);
};
const signed = (v: number, digits = 0) => (v > 0 ? '+' : '') + money(v, digits);
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const sym = (id: string) => instrumentById(id)?.symbol ?? id;
const px = (id: string, v: number) => {
  const i = instrumentById(id);
  return i ? formatPrice(v, i) : String(v);
};
/** Date and time in the formats / zone chosen in Settings. */
const dateTime = (ts: number) => `${fmtDate(ts)} ${fmtClock(ts, { seconds: false })}`;
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hold = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`;

function useJournal(): RoundTrip[] {
  const [, set] = useState(0);
  useEffect(() => journalStore.subscribe(() => set((x) => x + 1)), []);
  return journalStore.trips();
}

type SortKey = 'date' | 'instrument' | 'side' | 'qty' | 'entry' | 'exit' | 'pnl' | 'r' | 'tags';
const sortValue = (t: RoundTrip, k: SortKey): number | string => {
  switch (k) {
    case 'date':
      return t.exitTs;
    case 'instrument':
      return sym(t.instrumentId);
    case 'side':
      return t.side;
    case 'qty':
      return t.qty;
    case 'entry':
      return t.entryPx;
    case 'exit':
      return t.exitPx;
    case 'pnl':
      return netOf(t);
    case 'r':
      return rMultiple(t) ?? -Infinity;
    default:
      return journalStore
        .meta(t.id)
        .tags.map((x) => x.text)
        .join(' ');
  }
};

/** Equity curve (net of commission) with the drawdown line, drawn on a canvas. */
function EquityChart({ points }: { points: EquityPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--ht-up').trim() || '#20C77A';
      const down = css.getPropertyValue('--ht-down').trim() || '#F04A5D';
      const grid = css.getPropertyValue('--ht-divider').trim() || '#161616';
      const text = css.getPropertyValue('--ht-text-tertiary').trim() || '#838383';
      const pad = { l: 8, r: 56, t: 8, b: 8 };
      const pts = [{ ts: 0, equity: 0, drawdown: 0 }, ...points];
      const lo = Math.min(0, ...pts.map((p) => Math.min(p.equity, p.drawdown)));
      const hi = Math.max(0, ...pts.map((p) => p.equity));
      const span = hi - lo || 1;
      const x = (i: number) => pad.l + (i / Math.max(1, pts.length - 1)) * (w - pad.l - pad.r);
      const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b);
      g.strokeStyle = grid;
      g.fillStyle = text;
      g.font = '10px Geist, sans-serif';
      g.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = lo + (span * i) / 4;
        g.beginPath();
        g.moveTo(pad.l, Math.round(y(v)) + 0.5);
        g.lineTo(w - pad.r, Math.round(y(v)) + 0.5);
        g.stroke();
        g.fillText(money(v), w - pad.r + 6, y(v));
      }
      if (pts.length < 2) return;
      // Equity area + line.
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.equity)) : g.moveTo(x(i), y(p.equity))));
      g.strokeStyle = up;
      g.lineWidth = 1.5;
      g.stroke();
      g.lineTo(x(pts.length - 1), y(0));
      g.lineTo(x(0), y(0));
      g.closePath();
      g.globalAlpha = 0.12;
      g.fillStyle = up;
      g.fill();
      g.globalAlpha = 1;
      // Drawdown (≤ 0), dashed.
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.drawdown)) : g.moveTo(x(i), y(p.drawdown))));
      g.setLineDash([3, 3]);
      g.strokeStyle = down;
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [points]);
  return <canvas ref={ref} className="jr-canvas" data-testid="journal-equity" />;
}

/** Monthly calendar heatmap of daily net P&L (green / red intensity). */
function Calendar({ trips }: { trips: RoundTrip[] }) {
  const [offset, setOffset] = useState(0);
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const firstDay = useSetting('general.firstDayOfWeek'); // Settings → General
  const startIdx = firstDay === 'sunday' ? 6 : firstDay === 'saturday' ? 5 : 0; // index in DOW
  const dows = [...DOW.slice(startIdx), ...DOW.slice(0, startIdx)];
  const lead = (((first.getDay() + 6) % 7) - startIdx + 7) % 7;
  const daily = useMemo(() => dailyPnl(trips, localDayKey), [trips]);
  const key = (d: number) =>
    `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let max = 1;
  for (let d = 1; d <= days; d++) max = Math.max(max, Math.abs(daily.get(key(d))?.net ?? 0));
  return (
    <div className="jr-panel jr-cal" data-testid="journal-calendar">
      <div className="jr-panel-head">
        <b>
          {MONTHS[first.getMonth()]} {first.getFullYear()} · daily P&amp;L
        </b>
        <span className="grow" />
        <button
          className="jr-nav"
          aria-label={tl('Previous month')}
          onClick={() => setOffset(offset - 1)}
        >
          ‹
        </button>
        <button
          className="jr-nav"
          aria-label={tl('Next month')}
          onClick={() => setOffset(offset + 1)}
        >
          ›
        </button>
      </div>
      <div className="jr-cal-grid">
        {dows.map((d) => (
          <span key={d} className="jr-cal-dow">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = daily.get(key(i + 1));
          const a = d ? 0.18 + 0.6 * (Math.abs(d.net) / max) : 0;
          const col = d && d.net < 0 ? 'var(--ht-down)' : 'var(--ht-up)';
          return (
            <span
              key={i}
              className="jr-day"
              title={d ? `${d.trades} trades · ${signed(d.net, 2)}` : undefined}
              style={
                d
                  ? {
                      background: `color-mix(in srgb, ${col} ${Math.round(a * 100)}%, transparent)`,
                    }
                  : undefined
              }
            >
              <i>{i + 1}</i>
              {d && <b className="tnum">{(d.net > 0 ? '+' : '') + Math.round(d.net)}</b>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const TAG_KINDS: TagKind[] = ['setup', 'mistake', 'emotion', 'custom'];

function Detail({ trip }: { trip: RoundTrip }) {
  const m = journalStore.meta(trip.id);
  const [tag, setTag] = useState('');
  const [kind, setKind] = useState<TagKind>('setup');
  const tape = hub.peek(trip.instrumentId)?.tradesBetween(trip.entryTs, trip.exitTs) ?? [];
  const ex = excursion(trip, tape);
  const net = netOf(trip);
  const addTag = () => {
    const text = tag.trim();
    if (!text || m.tags.some((x) => x.text === text)) return;
    journalStore.setMeta(trip.id, { tags: [...m.tags, { text, kind }] });
    setTag('');
  };
  const attach = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 1_500_000) {
        toast('warning', tl('Image too large'), tl('Attachments are limited to 1.5 MB each.'));
        continue;
      }
      const r = new FileReader();
      r.onload = () =>
        journalStore.setMeta(trip.id, {
          attachments: [...journalStore.meta(trip.id).attachments, String(r.result)],
        });
      r.readAsDataURL(f);
    }
  };
  return (
    <div className="jr-panel jr-detail" data-testid="journal-detail">
      <div className="jr-panel-head">
        <b>
          {tl('Trade ·')} {sym(trip.instrumentId)} · {trip.side.toUpperCase()} {trip.qty}
        </b>
        <span className="grow" />
        <b className={`tnum ${cls(net)}`}>{signed(net, 2)}</b>
      </div>
      <div className="jr-kpis">
        <div>
          <span className="muted">{tl('MAE')}</span>
          <b className="tnum">{ex.samples ? `${ex.maeTicks.toFixed(0)} ticks` : '—'}</b>
        </div>
        <div>
          <span className="muted">{tl('MFE')}</span>
          <b className="tnum">{ex.samples ? `+${ex.mfeTicks.toFixed(0)} ticks` : '—'}</b>
        </div>
        <div>
          <span className="muted">{tl('Hold')}</span>
          <b className="tnum">{hold(trip.exitTs - trip.entryTs)}</b>
        </div>
      </div>
      <span className="muted">{tl('Setup / mistake / emotion')}</span>
      <div className="jr-tags">
        {m.tags.map((t: JournalTag) => (
          <button
            key={t.text}
            className={`jr-tag jr-tag--${t.kind}`}
            title={tl('Remove tag')}
            onClick={() =>
              journalStore.setMeta(trip.id, { tags: m.tags.filter((x) => x.text !== t.text) })
            }
          >
            {t.text} ×
          </button>
        ))}
      </div>
      <div className="row gap6">
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Tag kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as TagKind)}
        >
          {TAG_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          className="ht-input jr-in grow"
          placeholder={tl('+ tag')}
          aria-label={tl('New tag')}
          list="jr-all-tags"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
        />
        <datalist id="jr-all-tags">
          {journalStore.allTags().map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <Button size="xs" onClick={addTag}>
          {tl('Add')}
        </Button>
      </div>
      <span className="muted">{tl('Notes')}</span>
      <textarea
        className="jr-notes"
        aria-label={tl('Notes')}
        value={m.notes}
        onChange={(e) => journalStore.setMeta(trip.id, { notes: e.target.value })}
      />
      <div className="row gap8 center-y">
        <span className="muted">{tl('Rating')}</span>
        <span role="radiogroup" aria-label={tl('Rating')}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={m.rating === n}
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
              className={`jr-star ${n <= m.rating ? 'on' : ''}`}
              onClick={() => journalStore.setMeta(trip.id, { rating: m.rating === n ? 0 : n })}
            >
              ★
            </button>
          ))}
        </span>
      </div>
      <span className="muted">{tl('Attachments')}</span>
      <div className="jr-att">
        {m.attachments.map((a, i) => (
          <button
            key={i}
            title={tl('Remove attachment')}
            onClick={() =>
              journalStore.setMeta(trip.id, {
                attachments: m.attachments.filter((_, k) => k !== i),
              })
            }
          >
            <img src={a} alt={`Attachment ${i + 1}`} />
          </button>
        ))}
        <label className="jr-att-add">
          {tl('+ image')}
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => attach(e.target.files)}
          />
        </label>
      </div>
      {trip.manual && (
        <Button size="xs" variant="destructive" onClick={() => journalStore.remove(trip.id)}>
          {tl('Delete manual entry')}
        </Button>
      )}
    </div>
  );
}

function ManualDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const insts = allInstruments(true);
  const [inst, setInst] = useState(insts[0]?.id ?? '');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [qty, setQty] = useState('1');
  const [entry, setEntry] = useState('');
  const [exit, setExit] = useState('');
  const [comm, setComm] = useState('0');
  const [risk, setRisk] = useState('');
  const i = instrumentById(inst);
  const q = parseFloat(qty);
  const en = parseFloat(entry);
  const ex = parseFloat(exit);
  const valid = !!i && q > 0 && Number.isFinite(en) && Number.isFinite(ex);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={tl('Manual journal entry')}
      width={420}
    >
      <form
        className="col gap12"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || !i) return;
          const entryPx = Math.round(en / i.tickSize);
          const exitPx = Math.round(ex / i.tickSize);
          const r = parseFloat(risk);
          const now = Date.now();
          journalStore.addManual({
            instrumentId: i.id,
            accountId: 'manual',
            side,
            qty: q,
            entryPx,
            exitPx,
            entryTs: now - 60_000,
            exitTs: now,
            pnl: (exitPx - entryPx) * (side === 'long' ? 1 : -1) * q * pnlTick(i.id),
            commission: Math.max(0, parseFloat(comm) || 0),
            risk: r > 0 ? r : undefined,
          });
          onClose();
        }}
      >
        <div className="grid2">
          <Field label={tl('Instrument')}>
            <select className="ht-select" value={inst} onChange={(e) => setInst(e.target.value)}>
              {insts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.symbol} · {x.exchange}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tl('Side')}>
            <select
              className="ht-select"
              value={side}
              onChange={(e) => setSide(e.target.value as 'long' | 'short')}
            >
              <option value="long">{tl('Long')}</option>
              <option value="short">{tl('Short')}</option>
            </select>
          </Field>
          <Field label={tl('Quantity')}>
            <Input value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label={tl('Commission ($)')}>
            <Input value={comm} inputMode="decimal" onChange={(e) => setComm(e.target.value)} />
          </Field>
          <Field label={tl('Entry price')}>
            <Input value={entry} inputMode="decimal" onChange={(e) => setEntry(e.target.value)} />
          </Field>
          <Field label={tl('Exit price')}>
            <Input value={exit} inputMode="decimal" onChange={(e) => setExit(e.target.value)} />
          </Field>
          <Field label={tl('Risk ($, optional)')} hint={tl('Used for the R multiple')}>
            <Input value={risk} inputMode="decimal" onChange={(e) => setRisk(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={!valid}>
          {tl('Add entry')}
        </Button>
      </form>
    </Dialog>
  );
}

interface Params {
  account: string;
  period: JournalPeriod;
  tag: string;
  instrument: string;
}

function Journal({ params, setParams }: { params: Params; setParams(p: Partial<Params>): void }) {
  useTimeFormat();
  usePrivacy();
  const all = useJournal();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const accounts = [...paper.accounts.values()];
  const trips = useMemo(() => {
    const from = periodStart(params.period, Date.now());
    return all.filter((t) => {
      if (t.exitTs < from) return false;
      if (params.account === 'replay') {
        if (paper.accounts.get(t.accountId)?.kind !== 'replay') return false;
      } else if (params.account === 'vps') {
        // Strategy VPS runners (paper, imported from the user's own VPS).
        if (!t.accountId.startsWith('vps:')) return false;
      } else if (params.account !== 'all' && t.accountId !== params.account) return false;
      if (params.instrument !== 'all' && t.instrumentId !== params.instrument) return false;
      if (params.tag !== 'all' && !journalStore.meta(t.id).tags.some((x) => x.text === params.tag))
        return false;
      return true;
    });
  }, [all, params.account, params.period, params.tag, params.instrument]);
  const startBal =
    params.account === 'vps'
      ? 0
      : params.account !== 'all' && params.account !== 'replay'
        ? (paper.accounts.get(params.account)?.startingBalance ?? 0)
        : accounts.reduce((a, x) => a + x.startingBalance, 0);
  const s = useMemo(
    () =>
      journalStats(trips, {
        startingBalance: startBal,
        tagsOf: (t) =>
          journalStore
            .meta(t.id)
            .tags.filter((x) => x.kind === 'setup')
            .map((x) => x.text),
      }),
    [trips, startBal],
  );
  const curve = useMemo(() => equityCurve(trips), [trips]);
  const sorted = useMemo(
    () =>
      [...trips].sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        return (
          sort.dir *
          (typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y)))
        );
      }),
    [trips, sort],
  );
  const sel = sorted.find((t) => t.id === selected) ?? sorted[0] ?? null;
  const instruments = [...new Set(all.map((t) => t.instrumentId))];
  const exportCsv = () =>
    downloadText(
      `htflow-journal-${localDayKey(Date.now())}.csv`,
      toCsv(sorted, [
        { id: 'entry-time', header: 'Entry time', value: (t) => new Date(t.entryTs).toISOString() },
        { id: 'exit-time', header: 'Exit time', value: (t) => new Date(t.exitTs).toISOString() },
        {
          id: 'account',
          header: 'Account',
          value: (t) =>
            paper.accounts.get(t.accountId)?.name ??
            (t.accountId.startsWith('vps:') ? `VPS (${t.accountId.slice(4)})` : t.accountId),
        },
        { id: 'instrument', header: 'Instrument', value: (t) => sym(t.instrumentId) },
        { id: 'side', header: 'Side', value: (t) => t.side },
        { id: 'qty', header: 'Qty', value: (t) => t.qty },
        { id: 'entry', header: 'Entry', value: (t) => px(t.instrumentId, t.entryPx) },
        { id: 'exit', header: 'Exit', value: (t) => px(t.instrumentId, t.exitPx) },
        { id: 'gross', header: 'Gross P&L', value: (t) => t.pnl.toFixed(2) },
        { id: 'comm', header: 'Commission', value: (t) => t.commission.toFixed(2) },
        { id: 'net', header: 'Net P&L', value: (t) => netOf(t).toFixed(2) },
        { id: 'r', header: 'R', value: (t) => rMultiple(t)?.toFixed(2) ?? '' },
        {
          id: 'tags',
          header: 'Tags',
          value: (t) =>
            journalStore
              .meta(t.id)
              .tags.map((x) => x.text)
              .join('; '),
        },
        { id: 'rating', header: 'Rating', value: (t) => journalStore.meta(t.id).rating || '' },
        { id: 'notes', header: 'Notes', value: (t) => journalStore.meta(t.id).notes },
      ]),
    );
  const th = (key: SortKey, label: string, right = false) => (
    <th
      className={right ? 'r' : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : -1 })}
    >
      {label} {sort.key === key ? (sort.dir === 1 ? '▴' : '▾') : ''}
    </th>
  );
  const card = (label: string, value: string, sub: string, tone = '', testId?: string) => (
    <div className="jr-card" data-testid={testId}>
      <span className="muted">{label}</span>
      <b className={`tnum ${tone}`}>{value}</b>
      <span className="jr-sub tnum">{sub}</span>
    </div>
  );
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <div className="module-window jr" data-testid="journal-window">
      <div className="jr-toolbar">
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Account')}
          value={params.account}
          onChange={(e) => setParams({ account: e.target.value })}
        >
          <option value="all">{tl('All accounts')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="replay">{tl('Replay')}</option>
          <option value="vps">{tl('VPS')}</option>
          <option value="manual">{tl('Manual entries')}</option>
        </select>
        <div className="ht-seg" role="group" aria-label={tl('Period')}>
          {PERIODS.map((p) => (
            <button
              key={p.id}
              aria-pressed={params.period === p.id}
              onClick={() => setParams({ period: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Tag filter')}
          value={params.tag}
          onChange={(e) => setParams({ tag: e.target.value })}
        >
          <option value="all">{tl('Tags: all')}</option>
          {journalStore.allTags().map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Instrument filter')}
          value={params.instrument}
          onChange={(e) => setParams({ instrument: e.target.value })}
        >
          <option value="all">{tl('Instrument: all')}</option>
          {instruments.map((i) => (
            <option key={i} value={i}>
              {sym(i)}
            </option>
          ))}
        </select>
        <span className="grow" />
        <Button size="sm" variant="outline" onClick={exportCsv}>
          {tl('Export CSV')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setManual(true)}>
          {tl('+ Manual entry')}
        </Button>
      </div>
      <div className="jr-body">
        <div className="jr-cards">
          {card(
            'Net P&L',
            signed(s.netPnl, 2),
            `after ${money(s.commission, 2)} commission`,
            cls(s.netPnl),
            'journal-net',
          )}
          {card(
            'Trades',
            String(s.trades),
            `${s.wins} wins · ${s.losses} losses`,
            '',
            'journal-trades',
          )}
          {card(
            'Win rate',
            pct(s.winRate),
            `long ${pct(s.longWinRate)} · short ${pct(s.shortWinRate)}`,
          )}
          {card(
            'Profit factor',
            Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞',
            'gross win / gross loss',
            s.profitFactor >= 1 ? 'up' : s.trades ? 'down' : '',
          )}
          {card(
            'Expectancy',
            signed(s.expectancy, 2),
            `per trade · ${Number.isNaN(s.expectancyR) ? '— R' : `${s.expectancyR.toFixed(2)} R`}`,
            cls(s.expectancy),
          )}
          {card(
            'Avg win / loss',
            `${money(s.avgWin)} / ${money(-s.avgLoss)}`,
            `ratio ${Number.isFinite(s.winLossRatio) ? s.winLossRatio.toFixed(2) : '∞'}`,
          )}
          {card(
            'Max drawdown',
            money(-s.maxDrawdown, 2),
            Number.isNaN(s.maxDrawdownTs)
              ? '—'
              : `${pct(s.maxDrawdownPct)} · ${fmtDate(s.maxDrawdownTs)}`,
            s.maxDrawdown > 0 ? 'down' : '',
          )}
          {card(
            'Best setup',
            s.bestSetup?.tag ?? '—',
            s.bestSetup
              ? `${signed(s.bestSetup.net)} · ${s.bestSetup.trades} trades`
              : 'tag trades with a setup',
          )}
        </div>
        <div className="jr-row">
          <div className="jr-panel jr-eq">
            <div className="jr-panel-head">
              <b>{tl('Equity curve')}</b>
              <span className="grow" />
              <span className="muted">
                {tl('net of commission ·')} <span className="up">{tl('— Equity')}</span>{' '}
                <span className="down">{tl('┄ Drawdown')}</span>
              </span>
            </div>
            <EquityChart points={curve} />
          </div>
          <Calendar trips={trips} />
        </div>
        <div className="jr-row jr-row--grow">
          <div className="jr-panel jr-table">
            <table className="jr-tbl tnum">
              <thead>
                <tr>
                  {th('date', 'Date')}
                  {th('instrument', 'Instrument')}
                  {th('side', 'Side')}
                  {th('qty', 'Qty', true)}
                  {th('entry', 'Entry', true)}
                  {th('exit', 'Exit', true)}
                  {th('pnl', 'P&L', true)}
                  {th('r', 'R', true)}
                  {th('tags', 'Tags')}
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 500).map((t) => {
                  const n = netOf(t);
                  const r = rMultiple(t);
                  return (
                    <tr
                      key={t.id}
                      aria-selected={sel?.id === t.id}
                      onClick={() => setSelected(t.id)}
                      data-testid="journal-row"
                    >
                      <td
                        className="muted"
                        title={exchangeTimeTitle(
                          t.exitTs,
                          instrumentById(t.instrumentId)?.assetClass,
                        )}
                      >
                        {dateTime(t.exitTs)}
                      </td>
                      <td className="mono">{sym(t.instrumentId)}</td>
                      <td className={t.side === 'long' ? 'up b' : 'down b'}>
                        {t.side.toUpperCase()}
                      </td>
                      <td className="r">{t.qty}</td>
                      <td className="r">{px(t.instrumentId, t.entryPx)}</td>
                      <td className="r">{px(t.instrumentId, t.exitPx)}</td>
                      <td className={`r b ${cls(n)}`}>{signed(n, 2)}</td>
                      <td className={`r ${r === null ? 'muted' : cls(r)}`}>
                        {r === null ? '—' : r.toFixed(1)}
                      </td>
                      <td>
                        {journalStore
                          .meta(t.id)
                          .tags.map((x) => x.text)
                          .join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!sorted.length && (
              <div className="tbl-empty">
                {tl('No trades in this period. Closed paper trades are logged here automatically.')}
              </div>
            )}
          </div>
          {sel && <Detail key={sel.id} trip={sel} />}
        </div>
      </div>
      <ManualDialog open={manual} onClose={() => setManual(false)} />
    </div>
  );
}

registerModule({
  id: 'journal',
  view: function JournalModule({ state, setParams }) {
    const p = state.params ?? {};
    const period = PERIODS.some((x) => x.id === p.period) ? (p.period as JournalPeriod) : 'month';
    return (
      <Journal
        params={{
          account: typeof p.account === 'string' ? p.account : 'all',
          period,
          tag: typeof p.tag === 'string' ? p.tag : 'all',
          instrument: typeof p.instrument === 'string' ? p.instrument : 'all',
        }}
        setParams={setParams}
      />
    );
  },
});
