import { useEffect, useMemo, useState } from 'react';
import { Lock, Pin, Plus, X } from 'lucide-react';
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DropdownMenu,
  Input,
  MenuTrigger,
  NumberInput,
  Select,
  type MenuEntry,
} from '@htflow/ui-kit';
import {
  FULL_CAPABILITIES,
  specLabel,
  specUnavailableReason,
  type BarSpec,
  type FeedCapabilities,
} from '@htflow/market-data';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { hub } from '../../state/market';
import {
  openTimeframeDialog,
  paramsFor,
  sameBase,
  specFromParams,
  useTfDialog,
  useTimeframes,
  withSession,
  type TfRow,
} from './presets';
import './timeframes.css';

type Session = BarSpec['session'];

function capsFor(instrumentId: string): FeedCapabilities {
  return hub.peek(instrumentId)?.capabilities ?? FULL_CAPABILITIES;
}

function setTimeframe(windowId: string, spec: BarSpec): void {
  useWindows
    .getState()
    .patch(windowId, { timeframe: spec as ChartWindowState['timeframe'] } as Partial<WindowState>);
}

/** Header quick chips (user-pinned favourites) + the TF menu with the timeframe dialog. */
export function TimeframeHeader({ windowId, s }: { windowId: string; s: ChartWindowState }) {
  const { rows, pinned, loaded, load } = useTimeframes();
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  const cur = s.timeframe as BarSpec;
  const caps = capsFor(s.instrumentId);
  const apply = (sp: BarSpec) => setTimeframe(windowId, withSession(sp, cur.session));
  const items: MenuEntry[] = [
    ...rows
      .filter((r) => r.specs.length)
      .map((r) => ({
        kind: 'submenu' as const,
        id: r.row,
        label: r.row,
        items: r.specs.map((sp) => {
          const why = specUnavailableReason(sp, caps);
          return {
            id: JSON.stringify(sp),
            label: specLabel(sp) + (why ? ' (no data)' : ''),
            checked: sameBase(sp, cur),
            disabled: !!why,
            onSelect: () => apply(sp),
          };
        }),
      })),
    { kind: 'separator', id: 'sep' },
    { id: 'dialog', label: 'Timeframe dialog…', onSelect: () => openTimeframeDialog(windowId) },
    { id: 'configure', label: 'Configure…', onSelect: () => openTimeframeDialog(windowId, true) },
  ];
  return (
    <>
      {pinned.map((sp) => (
        <Chip
          key={JSON.stringify(sp)}
          variant="ghost"
          selected={sameBase(sp, cur)}
          disabled={!!specUnavailableReason(sp, caps)}
          title={specUnavailableReason(sp, caps) ?? undefined}
          onClick={() => apply(sp)}
        >
          {specLabel(sp)}
        </Chip>
      ))}
      {!pinned.some((q) => sameBase(q, cur)) && <Chip selected>{specLabel(cur)}</Chip>}
      <DropdownMenu items={items} trigger={<MenuTrigger aria-label="Timeframe">TF</MenuTrigger>} />
    </>
  );
}

const SESSIONS: { value: 'eth' | 'rth' | '24h' | 'custom'; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: 'eth', label: 'ETH' },
  { value: 'rth', label: 'RTH' },
  { value: 'custom', label: 'Custom…' },
];

const sessionValue = (s: Session) => (!s ? '24h' : typeof s === 'string' ? s : ('custom' as const));

/** Trading-session selector (bottom bar): RTH / ETH / 24h / custom window, saved with the bar type. */
export function SessionSelect({ windowId, s }: { windowId: string; s: ChartWindowState }) {
  const cur = s.timeframe as BarSpec;
  const [custom, setCustom] = useState(false);
  return (
    <>
      <Select
        small
        aria-label="Trading session"
        value={sessionValue(cur.session)}
        onChange={(v) => {
          if (v === 'custom') setCustom(true);
          else setTimeframe(windowId, withSession(cur, v));
        }}
        options={SESSIONS}
      />
      <CustomSessionDialog
        open={custom}
        onOpenChange={setCustom}
        initial={typeof cur.session === 'object' ? cur.session : undefined}
        onApply={(sess) => setTimeframe(windowId, withSession(cur, sess))}
      />
    </>
  );
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function CustomSessionDialog({
  open,
  onOpenChange,
  initial,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: { open: string; close: string; tz?: string; days?: number[] };
  onApply: (s: { open: string; close: string; tz?: string; days?: number[] }) => void;
}) {
  const [o, setO] = useState(initial?.open ?? '09:30');
  const [c, setC] = useState(initial?.close ?? '16:00');
  const [tz, setTz] = useState(initial?.tz ?? '');
  const [days, setDays] = useState<number[]>(initial?.days ?? [1, 2, 3, 4, 5]);
  const tzOk =
    !tz ||
    (() => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    })();
  const ok = HHMM.test(o) && HHMM.test(c) && tzOk && days.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Custom session"
      description="Exchange-local hours; leave the time zone empty to use the instrument's exchange zone."
      width={380}
    >
      <div className="col gap12">
        <div className="row gap8">
          <label className="tf-field">
            Open
            <Input value={o} onChange={(e) => setO(e.target.value)} aria-label="Session open" />
          </label>
          <label className="tf-field">
            Close
            <Input value={c} onChange={(e) => setC(e.target.value)} aria-label="Session close" />
          </label>
        </div>
        <label className="tf-field">
          Time zone (IANA)
          <Input
            value={tz}
            placeholder="e.g. America/New_York"
            onChange={(e) => setTz(e.target.value)}
            aria-label="Session time zone"
          />
        </label>
        <div className="row gap8 wrap">
          {DAYS.map((d, i) => (
            <Checkbox
              key={d}
              label={d}
              checked={days.includes(i)}
              onChange={(v) => setDays(v ? [...days, i].sort() : days.filter((x) => x !== i))}
            />
          ))}
        </div>
        {!ok && (
          <span className="ht-error">Use HH:MM times, a valid time zone and at least one day.</span>
        )}
        <div className="row gap8">
          <div className="grow" />
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ok}
            onClick={() => {
              onApply({ open: o, close: c, ...(tz ? { tz } : {}), days });
              onOpenChange(false);
            }}
          >
            Apply
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Timeframe dialog (P07): rows × preset chips, disabled chips, Configure and Apply. */
export function TimeframeDialogHost({ windowId, s }: { windowId: string; s: ChartWindowState }) {
  const open = useTfDialog((d) => d.windowId === windowId);
  const configureInit = useTfDialog((d) => d.configure);
  const { rows, pinned, addChip, removeChip, togglePin, reset, loaded, load } = useTimeframes();
  const cur = s.timeframe as BarSpec;
  const [pending, setPending] = useState<BarSpec>(cur);
  const [configure, setConfigure] = useState(false);
  const caps = useMemo(() => capsFor(s.instrumentId), [s.instrumentId, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) {
      setPending(cur);
      setConfigure(configureInit);
      if (!loaded) void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => useTfDialog.setState({ windowId: null, configure: false });
  const apply = (sp: BarSpec) => {
    setTimeframe(windowId, withSession(sp, cur.session));
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={configure ? 'Configure timeframes' : 'Timeframe'}
      description={
        configure
          ? 'Add or remove chips per bar type; pin favourites to the window header. Saved to your profile.'
          : 'Pick a bar type. Greyed chips need data this feed does not supply.'
      }
      width={640}
    >
      <div className="tf-grid" data-testid="timeframe-dialog">
        {rows.map((r) => (
          <TfRowView
            key={r.row}
            row={r}
            pending={pending}
            configure={configure}
            caps={caps}
            pinned={pinned}
            onPick={setPending}
            onApply={apply}
            onRemove={(sp) => removeChip(r.row, sp)}
            onPin={togglePin}
            onAdd={(sp) => addChip(r.row, sp)}
          />
        ))}
      </div>
      <div className="row gap8 tf-foot">
        <span
          className="muted tf-dates"
          title="History range selection arrives with the tick store (P06)"
        >
          Set dates: Auto <Lock size={11} />
        </span>
        <div className="grow" />
        {configure && (
          <Button variant="ghost" onClick={reset}>
            Reset to defaults
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => setConfigure((x) => !x)}
          data-testid="tf-configure"
        >
          {configure ? 'Done' : 'Configure'}
        </Button>
        <Button variant="primary" onClick={() => apply(pending)} data-testid="tf-apply">
          Apply
        </Button>
      </div>
    </Dialog>
  );
}

function TfRowView({
  row,
  pending,
  configure,
  caps,
  pinned,
  onPick,
  onApply,
  onRemove,
  onPin,
  onAdd,
}: {
  row: TfRow;
  pending: BarSpec;
  configure: boolean;
  caps: FeedCapabilities;
  pinned: BarSpec[];
  onPick(sp: BarSpec): void;
  onApply(sp: BarSpec): void;
  onRemove(sp: BarSpec): void;
  onPin(sp: BarSpec): void;
  onAdd(sp: BarSpec): void;
}) {
  const [adding, setAdding] = useState(false);
  const params = paramsFor(row);
  const [vals, setVals] = useState<Record<string, number>>(() =>
    Object.fromEntries(params.map((p) => [p.key, p.def])),
  );
  return (
    <>
      <div className="tf-row-label">{row.row}</div>
      <div className="tf-row-chips">
        {row.specs.map((sp) => {
          const why = specUnavailableReason(sp, caps);
          const isPinned = pinned.some((p) => sameBase(p, sp));
          return (
            <span key={JSON.stringify(sp)} className="tf-chip-wrap">
              <Chip
                selected={sameBase(sp, pending)}
                disabled={!!why && !configure}
                title={why ?? specLabel(sp)}
                data-testid={`tf-chip-${specLabel(sp)}`}
                onClick={() => (configure ? onPin(sp) : onPick(sp))}
                onDoubleClick={() => !configure && !why && onApply(sp)}
              >
                {specLabel(sp)}
                {isPinned && <Pin size={9} className="tf-pin" aria-label="Pinned" />}
              </Chip>
              {configure && (
                <button
                  className="tf-chip-x"
                  aria-label={`Remove ${specLabel(sp)}`}
                  onClick={() => onRemove(sp)}
                >
                  <X size={10} />
                </button>
              )}
            </span>
          );
        })}
        {configure &&
          (adding ? (
            <span className="tf-add">
              {params.map((p) => (
                <label key={p.key} className="tf-param">
                  {p.label}
                  <NumberInput
                    value={vals[p.key] ?? p.def}
                    min={p.min}
                    max={p.max}
                    aria-label={`${row.row} ${p.label}`}
                    onChange={(v) => setVals({ ...vals, [p.key]: v })}
                  />
                </label>
              ))}
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  onAdd(specFromParams(row, vals));
                  setAdding(false);
                }}
              >
                Add
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <button
              className="tf-chip-add"
              aria-label={`Add ${row.row} preset`}
              onClick={() => setAdding(true)}
            >
              <Plus size={11} />
            </button>
          ))}
      </div>
    </>
  );
}
