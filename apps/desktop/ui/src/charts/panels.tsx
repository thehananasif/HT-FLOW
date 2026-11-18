/** Chart side panels and dialogs: data window, go to date, save template (P08 / P09 / P26). */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { barDataRows, type ChartCore, type DataRow } from '@htflow/chart-engine';
import { formatPrice, type BarSeries, type MarketStore } from '@htflow/market-data';
import { Button, Checkbox, Dialog, Field, Input, toast } from '@htflow/ui-kit';

import { translateLiteral as tl, tt } from '@htflow/i18n';
/** Data window: OHLCV, delta and every layer's value at the cursor (or the last bar). */
export function DataWindow({
  core,
  series,
  store,
  onClose,
  formatTime,
}: {
  core: ChartCore | null;
  series: () => BarSeries | null;
  store: MarketStore;
  onClose(): void;
  formatTime(t: number): string;
}) {
  const [slot, setSlot] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!core) return;
    let raf = 0;
    const un = core.onCrosshairMove((pt) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSlot(pt ? pt.slot : null));
    });
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => {
      un();
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [core]);
  const bars = series()?.bars ?? [];
  const i = slot !== null && slot >= 0 && slot < bars.length ? slot : bars.length - 1;
  const b = bars[i];
  const inst = store.instrument;
  const rows: DataRow[] = [];
  if (b) {
    const up = b.c >= b.o;
    const col = up ? 'var(--ht-up)' : 'var(--ht-down)';
    rows.push(
      { label: 'Time', value: formatTime(b.t) },
      { label: 'Open', value: formatPrice(b.o, inst), color: col },
      { label: 'High', value: formatPrice(b.h, inst), color: col },
      { label: 'Low', value: formatPrice(b.l, inst), color: col },
      { label: 'Close', value: formatPrice(b.c, inst), color: col },
      { label: 'Range', value: formatPrice(b.h - b.l, inst) },
      { label: 'Volume', value: b.vol.toLocaleString('en-US') },
      ...barDataRows(b),
    );
    const seen = new Set(rows.map((r) => r.label));
    for (const l of core?.layers ?? []) {
      for (const r of l.dataWindow?.(i) ?? []) {
        if (seen.has(r.label)) continue;
        seen.add(r.label);
        rows.push(r);
      }
    }
  }
  return (
    <aside className="chart-datawin" aria-label={tl('Data window')} data-testid="data-window">
      <header>
        <span>{tl('Data window')}</span>
        <button className="ht-icon-btn" aria-label={tl('Close data window')} onClick={onClose}>
          <X size={12} />
        </button>
      </header>
      {!b && <p className="muted">{tl('No bars loaded.')}</p>}
      <dl>
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{tl(r.label)}</dt>
            <dd className="tnum" style={r.color ? { color: r.color } : undefined}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

function localDate(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(t: number) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Calendar "Go to date" (Ctrl+G): scrolls to the bar at that time, loading older history if needed. */
export function GoToDateDialog({
  open,
  onOpenChange,
  firstTime,
  lastTime,
  onGo,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  firstTime: number;
  lastTime: number;
  onGo(t: number): Promise<void>;
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = lastTime || Date.now();
    setDate(localDate(t));
    setTime(localTime(t));
  }, [open, lastTime]);
  const go = async () => {
    const t = new Date(`${date}T${time || '00:00'}`).getTime();
    if (!Number.isFinite(t)) {
      toast('error', tl('Invalid date'));
      return;
    }
    setBusy(true);
    try {
      await onGo(t);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tl('Go to date')}
      description={
        firstTime
          ? `Loaded ${new Date(firstTime).toLocaleString()} – ${new Date(lastTime).toLocaleString()}. Earlier dates load more history.`
          : undefined
      }
      width={380}
    >
      <form
        className="col gap12"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Field label={tl('Date')}>
          <Input
            type="date"
            aria-label={tl('Date')}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={tl('Time (local)')}>
          <Input
            type="time"
            aria-label={tl('Time')}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>
        <div className="row gap8">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDate(localDate(Date.now()));
              setTime('00:00');
            }}
          >
            {tl('Today 00:00')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDate(localDate(firstTime || Date.now()));
              setTime(localTime(firstTime || Date.now()));
            }}
          >
            {tl('First bar')}
          </Button>
          <div className="grow" />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Loading…' : 'Go'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Save as template" prompt. */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  className,
  onSave,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  className: string;
  onSave(name: string, makeDefault: boolean): void;
}) {
  const [name, setName] = useState('');
  const [def, setDef] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setDef(false);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={tl('Save chart template')} width={380}>
      <form
        className="col gap12"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSave(name.trim(), def);
          onOpenChange(false);
        }}
      >
        <Field label={tl('Template name')}>
          <Input
            autoFocus
            aria-label={tl('Template name')}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Checkbox checked={def} onChange={setDef} label={tt`Default for ${className}`} />
        <div className="row gap8">
          <div className="grow" />
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {tl('Cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {tl('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
