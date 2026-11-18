import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Star, X } from 'lucide-react';
import { create } from 'zustand';
import { t, type Strings, translateLiteral as tl } from '@htflow/i18n';
import { Button, Dialog, Input, MenuTrigger, Popover, Select } from '@htflow/ui-kit';
import {
  FULL_CAPABILITIES,
  INTERVAL_GROUPS,
  INTERVAL_UNITS,
  groupOfSpec,
  intervalName,
  intervalToSpec,
  parseInterval,
  specLabel,
  specToInterval,
  specUnavailableReason,
  validateInterval,
  type BarSpec,
  type IntervalUnit,
} from '@htflow/market-data';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { hub } from '../../state/market';
import { openTimeframeDialog, sameBase, sameSpec, useTimeframes, withSession } from './presets';

/** Menu / palette name of a spec: "4 hours", "1 week"; other bar types use their short label. */
export function specName(spec: BarSpec): string {
  const iv = specToInterval(spec);
  return iv ? intervalName(iv) : specLabel(spec);
}

export function applyTimeframe(windowId: string, spec: BarSpec): void {
  const cur = useWindows.getState().windows[windowId];
  if (cur?.kind !== 'chart') return;
  useWindows.getState().patch(windowId, {
    timeframe: withSession(spec, (cur.timeframe as BarSpec).session),
  } as Partial<WindowState>);
}

/** Which chart window's "Add custom interval" dialog is open. */
export const useCustomDialog = create<{ windowId: string | null }>(() => ({ windowId: null }));
export const openCustomInterval = (windowId: string) => useCustomDialog.setState({ windowId });

interface MenuGroup {
  id: string;
  label: string;
  specs: BarSpec[];
}

/** Menu groups: the time / tick ladders, then the user's other bar types; customs join their group. */
export function buildGroups(
  rows: { row: string; kind: string; specs: BarSpec[] }[],
  custom: BarSpec[],
): MenuGroup[] {
  const defaults = new Set<string>();
  const groups: MenuGroup[] = INTERVAL_GROUPS.map((g) => {
    g.specs.forEach((s) => defaults.add(JSON.stringify(s)));
    return {
      id: g.id,
      label: t(`tf.group.${g.id}` as keyof Strings),
      specs: [...g.specs, ...custom.filter((c) => groupOfSpec(c) === g.id)],
    };
  });
  for (const r of rows) {
    if (r.kind === 'time' || r.kind === 'tick' || !r.specs.length) continue;
    const extra = custom.filter((c) => c.kind === r.kind && !r.specs.some((s) => sameSpec(s, c)));
    groups.push({ id: `row:${r.row}`, label: r.row, specs: [...r.specs, ...extra] });
  }
  return groups;
}

function caps(instrumentId: string) {
  return hub.peek(instrumentId)?.capabilities ?? FULL_CAPABILITIES;
}

/** The "TF" trigger and its popover: collapsible interval groups, stars, custom intervals. */
export function IntervalMenu({ windowId, s }: { windowId: string; s: ChartWindowState }) {
  const [open, setOpen] = useState(false);
  const { rows, pinned, custom, collapsed, togglePin, toggleGroup, removeCustom } = useTimeframes();
  const cur = s.timeframe as BarSpec;
  const feedCaps = caps(s.instrumentId);
  const groups = useMemo(() => buildGroups(rows, custom), [rows, custom]);
  const isCustom = (sp: BarSpec) => custom.some((c) => sameSpec(c, sp));
  const close = () => setOpen(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label={t('tf.menu')}
      className="iv-menu"
      testId="interval-menu"
      trigger={
        <MenuTrigger aria-label={`TF: ${t('tf.menu')}`} onClick={() => setOpen(!open)}>
          {tl('TF')}
        </MenuTrigger>
      }
    >
      <div role="menu" aria-label={t('tf.menu')}>
        <button
          role="menuitem"
          className="iv-add"
          onClick={() => {
            close();
            openCustomInterval(windowId);
          }}
        >
          <Plus size={14} /> {t('tf.addCustom')}
        </button>
        <div className="iv-scroll">
          {groups.map((g) => {
            const isOpen = !collapsed.includes(g.id);
            return (
              <div key={g.id} className="iv-group" data-testid={`iv-group-${g.id}`}>
                <button
                  className="iv-ghead"
                  aria-expanded={isOpen}
                  aria-label={tl(g.label)}
                  onClick={() => toggleGroup(g.id)}
                >
                  <span>{tl(g.label)}</span>
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {isOpen &&
                  g.specs.map((sp) => {
                    const name = specName(sp);
                    const why = specUnavailableReason(sp, feedCaps);
                    const fav = pinned.some((p) => sameBase(p, sp));
                    return (
                      <div
                        key={JSON.stringify(sp)}
                        className="iv-row"
                        data-active={sameBase(sp, cur) || undefined}
                      >
                        <button
                          role="menuitem"
                          className="iv-pick"
                          disabled={!!why}
                          title={why ?? undefined}
                          onClick={() => {
                            applyTimeframe(windowId, sp);
                            close();
                          }}
                        >
                          {name}
                          {why ? ` ${t('tf.noData')}` : ''}
                        </button>
                        {isCustom(sp) && (
                          <button
                            className="iv-icon"
                            aria-label={t('tf.removeCustom', { name })}
                            onClick={() => removeCustom(sp)}
                          >
                            <X size={12} />
                          </button>
                        )}
                        <button
                          className="iv-icon iv-star"
                          aria-pressed={fav}
                          aria-label={t(fav ? 'tf.unfavourite' : 'tf.favourite', { name })}
                          onClick={() => togglePin(sp)}
                        >
                          <Star size={12} fill={fav ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
        <div className="iv-foot">
          <button
            role="menuitem"
            onClick={() => {
              close();
              openTimeframeDialog(windowId);
            }}
          >
            {t('tf.dialog')}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              close();
              openTimeframeDialog(windowId, true);
            }}
          >
            {t('tf.configure')}
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** "Add custom interval…" dialog: number + unit, validated, saved to the profile. */
export function CustomIntervalDialogHost({ windowId }: { windowId: string }) {
  const open = useCustomDialog((d) => d.windowId === windowId);
  const { custom, rows, addCustom, loaded, load } = useTimeframes();
  const [text, setText] = useState('7');
  const [unit, setUnit] = useState<IntervalUnit>('minute');
  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);
  const n = Number(text);
  const spec = intervalToSpec({ unit, n });
  const err =
    validateInterval(unit, n) ??
    (custom.some((c) => sameSpec(c, spec)) ||
    INTERVAL_GROUPS.some((g) => g.specs.some((x) => sameSpec(x, spec))) ||
    rows.some((r) => r.kind === spec.kind && r.specs.some((x) => sameSpec(x, spec)))
      ? t('tf.custom.exists')
      : null);
  const close = () => useCustomDialog.setState({ windowId: null });
  const submit = () => {
    if (err) return;
    addCustom(spec);
    applyTimeframe(windowId, spec);
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t('tf.custom.title')}
      description={t('tf.custom.desc')}
      width={360}
    >
      <div className="col gap12" data-testid="custom-interval-dialog">
        <div className="row gap8">
          <label className="tf-field">
            {t('tf.custom.value')}
            <Input
              value={text}
              inputMode="numeric"
              aria-label={t('tf.custom.value')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label className="tf-field">
            {t('tf.custom.unit')}
            <Select
              aria-label={t('tf.custom.unit')}
              value={unit}
              onChange={setUnit}
              options={INTERVAL_UNITS.map((u) => ({ value: u.unit, label: u.label }))}
            />
          </label>
        </div>
        {err && (
          <span className="ht-error" role="alert">
            {err}
          </span>
        )}
        <div className="row gap8">
          <div className="grow" />
          <Button variant="ghost" onClick={close}>
            {t('tf.custom.cancel')}
          </Button>
          <Button variant="primary" disabled={!!err} onClick={submit} data-testid="custom-add">
            {t('tf.custom.add')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const editable = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable);
};

/** Typing a digit in the active chart opens a quick interval input: "15" Enter, "4h", "1D". */
export function QuickIntervalHost({ windowId }: { windowId: string }) {
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (text !== null || e.ctrlKey || e.metaKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
      if (editable(e.target) || (e.target as HTMLElement | null)?.closest?.('[role="dialog"]'))
        return;
      if (useWindows.getState().activeId !== windowId) return;
      e.preventDefault();
      setText(e.key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [text, windowId]);
  useEffect(() => {
    if (text !== null && input.current && document.activeElement !== input.current) {
      input.current.focus();
      const l = input.current.value.length;
      input.current.setSelectionRange(l, l);
    }
  }, [text]);
  if (text === null) return null;
  const parsed = parseInterval(text);
  return (
    <div className="iv-quick" data-testid="quick-interval">
      <label>
        {t('tf.quick.label')}
        <input
          ref={input}
          aria-label={t('tf.quick.label')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setText(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setText(null);
            else if (e.key === 'Enter' && !('error' in parsed)) {
              applyTimeframe(windowId, parsed.spec);
              setText(null);
            }
          }}
        />
      </label>
      <span className={'error' in parsed ? 'ht-error' : 'muted'}>
        {'error' in parsed ? parsed.error : intervalName(parsed.interval)}
      </span>
      <span className="muted iv-hint">{t('tf.quick.hint')}</span>
    </div>
  );
}
