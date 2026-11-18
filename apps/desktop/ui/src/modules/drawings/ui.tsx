import {
  Bell,
  BellOff,
  Copy,
  Eye,
  EyeOff,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Unlock,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  NumberInput,
  Select,
  Slider,
  toast,
} from '@htflow/ui-kit';
import { plural, t, translateLiteral as tl } from '@htflow/i18n';
import { formatPrice, specKey, specLabel, TIMEFRAME_PRESETS } from '@htflow/market-data';
import {
  ALERT_TRIGGERS,
  alertChannels,
  alertTrigger,
  drawingName,
  positionStats,
  prop,
  supportsAlert,
  SWATCHES,
  toolDef,
  triggersFor,
  type Dash,
  type Drawing,
  type FibLevel,
} from '@htflow/drawings';
import type { ChartWindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { toolLabel, toolNote } from './toolText';
import { hub, paper, PAPER_ACCOUNT } from '../../state/market';
import type { ModuleViewProps } from '../registry';
import { EmojiPicker } from './emoji';
import {
  activeChartId,
  controllers,
  mutate,
  mutateSelection,
  readDrawings,
  runToolCommand,
  selectionOf,
  useDrawUi,
} from './store';

const patchOne = (windowId: string, id: string, fn: (d: Drawing) => Drawing) =>
  mutate(windowId, (items) => items.map((d) => (d.id === id ? fn(d) : d)));
const removeOne = (windowId: string, id: string) => {
  mutate(windowId, (items) => items.filter((d) => d.id !== id));
  if (useDrawUi.getState().selected[windowId] === id) useDrawUi.getState().select(windowId, null);
};
/** Style edits apply to the whole multi-selection when the edited drawing is part of it. */
const setStyle = (windowId: string, id: string, s: Partial<Drawing['style']>) => {
  const sel = selectionOf(windowId);
  if (sel.length > 1 && sel.includes(id))
    mutateSelection(windowId, (d) => ({ ...d, style: { ...d.style, ...s } }));
  else patchOne(windowId, id, (d) => ({ ...d, style: { ...d.style, ...s } }));
};
/** Same for any other drawing patch (lock, extend, alert…). */
const patchGroup = (windowId: string, id: string, fn: (d: Drawing) => Drawing) => {
  const sel = selectionOf(windowId);
  if (sel.length > 1 && sel.includes(id)) mutateSelection(windowId, fn);
  else patchOne(windowId, id, fn);
};
const removeSelection = (windowId: string, id: string) => {
  const sel = selectionOf(windowId);
  const ids = new Set(sel.length > 1 && sel.includes(id) ? sel : [id]);
  mutate(windowId, (items) => items.filter((d) => !(ids.has(d.id) && !d.locked)));
  useDrawUi.getState().select(windowId, null);
};

function instrumentOf(instrumentId: string) {
  return hub.peek(instrumentId)?.instrument ?? null;
}

function nameOf(d: Drawing, instrumentId: string): string {
  const inst = instrumentOf(instrumentId);
  return drawingName(
    d,
    (px) => (inst ? formatPrice(Math.round(px), inst) : String(Math.round(px))),
    toolLabel,
  );
}

/** Style toolbar for the selected drawing + the properties dialog (chart extension Overlay). */
export function DrawingsOverlay({
  windowId,
  state,
}: {
  windowId: string;
  state: ChartWindowState;
}) {
  const selId = useDrawUi((s) => s.selected[windowId] ?? null);
  const multi = useDrawUi((s) => s.multi[windowId]);
  const nSel = multi && multi.length ? multi.length : selId ? 1 : 0;
  const tool = useDrawUi((s) => s.tool[windowId] ?? null);
  const showBar = useDrawUi((s) => s.prefs.toolbar);
  const editing = useDrawUi((s) => s.editing);
  const prefsOpen = useDrawUi((s) => s.prefsOpen) && activeChartId() === windowId;
  const items = readDrawings(windowId);
  const d = items.find((x) => x.id === selId) ?? null;
  const def = tool ? toolDef(tool) : null;
  return (
    <div
      className="dr-overlay"
      data-testid="drawings-overlay"
      data-count={items.length}
      data-hotkey-scope="chart"
    >
      {def && (
        <div className="dr-hint">
          {toolLabel(def.id)}
          {toolNote(def.id) ? ` — ${toolNote(def.id)}` : ''} {tl('· Esc to cancel')}
        </div>
      )}
      {d && showBar && !def && (
        <div
          className="dr-toolbar"
          role="toolbar"
          aria-label={t('drawings.toolbarAria')}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <span className="dr-name" data-testid="dr-name">
            {nSel > 1 ? t('drawings.nSelected', { n: nSel }) : toolLabel(d.type)}
          </span>
          <input
            type="color"
            aria-label={t('drawings.colour')}
            title={t('drawings.colour')}
            value={d.style.color.slice(0, 7)}
            onChange={(e) => setStyle(windowId, d.id, { color: e.target.value })}
          />
          <Select
            small
            aria-label={t('drawings.lineWidth')}
            value={String(d.style.width)}
            onChange={(v) => setStyle(windowId, d.id, { width: Number(v) })}
            options={[1, 2, 3, 4, 6].map((w) => ({
              value: String(w),
              label: t('drawings.px', { n: w }),
            }))}
          />
          <Select
            small
            aria-label={t('drawings.lineStyle')}
            value={d.style.dash}
            onChange={(v) => setStyle(windowId, d.id, { dash: v as Dash })}
            options={[
              { value: 'solid', label: t('drawings.solid') },
              { value: 'dashed', label: t('drawings.dashed') },
              { value: 'dotted', label: t('drawings.dotted') },
            ]}
          />
          <button
            className="dr-btn"
            aria-label={t('drawings.fill')}
            title={t('drawings.fill')}
            aria-pressed={!!d.style.fill}
            onClick={() => setStyle(windowId, d.id, { fill: d.style.fill ? '' : d.style.color })}
          >
            <span className="dr-fill" style={{ background: d.style.fill || 'transparent' }} />
          </button>
          <button
            className="dr-btn"
            aria-label={d.locked ? t('drawings.unlock') : t('drawings.lock')}
            title={d.locked ? t('drawings.unlock') : t('drawings.lock')}
            aria-pressed={d.locked}
            onClick={() => patchGroup(windowId, d.id, (x) => ({ ...x, locked: !d.locked }))}
          >
            {d.locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          {nSel === 1 && supportsAlert(d.type) && (
            <button
              className="dr-btn"
              aria-label={t('drawings.alertOnCross')}
              title={t('drawings.alertTitle')}
              aria-pressed={d.alert}
              onClick={() => patchOne(windowId, d.id, (x) => ({ ...x, alert: !x.alert }))}
            >
              {d.alert ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
          )}
          {nSel > 1 && (
            <button
              className="dr-btn"
              aria-label={t('drawings.alertOnCross')}
              title={t('drawings.alertTitleLines')}
              aria-pressed={d.alert}
              onClick={() =>
                mutateSelection(windowId, (x) =>
                  supportsAlert(x.type) ? { ...x, alert: !d.alert } : x,
                )
              }
            >
              {d.alert ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
          )}
          {nSel === 1 && (
            <button
              className="dr-btn"
              aria-label={t('drawings.clone')}
              title={t('drawings.clone')}
              onClick={() => controllers.get(windowId)?.ctrl.clone(d.id)}
            >
              <Copy size={14} />
            </button>
          )}
          <button
            className="dr-btn"
            aria-label={nSel > 1 ? t('drawings.deleteSelected') : t('drawings.deleteDrawing')}
            title={t('drawings.deleteTitle')}
            onClick={() => removeSelection(windowId, d.id)}
          >
            <Trash2 size={14} />
          </button>
          <button
            className="dr-btn"
            aria-label={t('drawings.moreProps')}
            title={t('drawings.properties')}
            onClick={() => useDrawUi.getState().edit({ windowId, id: d.id })}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}
      {editing?.windowId === windowId && (
        <PropertiesDialog windowId={windowId} id={editing.id} state={state} />
      )}
      {prefsOpen && <PrefsDialog windowId={windowId} />}
    </div>
  );
}

function PropertiesDialog({
  windowId,
  id,
  state,
}: {
  windowId: string;
  id: string;
  state: ChartWindowState;
}) {
  const d = readDrawings(windowId).find((x) => x.id === id);
  const close = () => useDrawUi.getState().edit(null);
  if (!d) return null;
  const def = toolDef(d.type);
  const upd = (fn: (x: Drawing) => Drawing) => patchGroup(windowId, id, fn);
  const nSel = selectionOf(windowId).includes(id) ? selectionOf(windowId).length : 1;
  const st = (s: Partial<Drawing['style']>) => setStyle(windowId, id, s);
  const setProp = (k: string, v: number | string | boolean) =>
    upd((x) => ({ ...x, props: { ...x.props, [k]: v } }));
  const levels = d.levels;
  const setLevels = (fn: (l: FibLevel[]) => FibLevel[]) =>
    upd((x) => ({ ...x, levels: fn(x.levels ?? []) }));
  const tfs = TIMEFRAME_PRESETS.flatMap((r) => r.specs).map((s) => ({
    key: specKey(s),
    label: specLabel(s),
  }));
  const allTf = d.visibleOn === 'all';
  const isPos = def?.group === 'risk';
  const isProfile = ['volume-profile', 'fixed-vp', 'anchored-vp', 'zigzag-vp'].includes(d.type);
  const canAlert = supportsAlert(d.type);
  const trigs = triggersFor(d.type);
  const ch = alertChannels(d);
  const inst = instrumentOf(state.instrumentId);
  const placeOrder = () => {
    if (!inst || d.anchors.length < 3) return;
    const side = d.type === 'long-position' ? 'long' : 'short';
    const p = positionStats(
      inst,
      side,
      d.anchors[0]!.px,
      d.anchors[1]!.px,
      d.anchors[2]!.px,
      prop(d, 'qty', 1),
      prop(d, 'risk', 0),
    );
    if (!(p.qty > 0) || p.slTicks <= 0 || p.tpTicks <= 0) {
      toast('error', t('drawings.cannotPlace'), t('drawings.checkQty'));
      return;
    }
    const o = paper.place({
      accountId: PAPER_ACCOUNT,
      instrumentId: state.instrumentId,
      side: side === 'long' ? 'buy' : 'sell',
      type: 'limit',
      qty: p.qty,
      px: Math.round(p.entry),
      bracket: { slTicks: p.slTicks, tpTicks: [p.tpTicks] },
    });
    if (o.status === 'rejected') toast('error', t('drawings.orderRejected'), o.reason);
    else
      toast(
        'success',
        t('drawings.orderPlaced', {
          side: side === 'long' ? t('drawings.buy') : t('drawings.sell'),
          qty: p.qty,
        }),
      );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={def ? toolLabel(d.type) : t('drawings.drawing')}
      width={460}
    >
      <div className="col gap12 dr-props">
        {nSel > 1 && (
          <div className="muted" data-testid="dr-group-note">
            {t('drawings.groupNote', { n: nSel })}
          </div>
        )}
        <div className="dr-swatches" role="radiogroup" aria-label={t('drawings.colour')}>
          {SWATCHES.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={d.style.color.toUpperCase() === c}
              aria-label={c}
              style={{ background: c }}
              onClick={() => st({ color: c })}
            />
          ))}
        </div>
        <div className="dr-grid">
          <Field label={t('drawings.opacity')}>
            <NumberInput
              value={Math.round(d.style.opacity * 100)}
              min={5}
              max={100}
              step={5}
              onChange={(v) => st({ opacity: v / 100 })}
            />
          </Field>
          <Field label={t('drawings.widthPx')}>
            <NumberInput value={d.style.width} min={1} max={8} onChange={(v) => st({ width: v })} />
          </Field>
          <Field label={t('drawings.fillOpacity')}>
            <NumberInput
              value={Math.round(d.style.fillOpacity * 100)}
              min={0}
              max={100}
              step={5}
              onChange={(v) => st({ fillOpacity: v / 100 })}
            />
          </Field>
          <Field label={t('drawings.fontSize')}>
            <NumberInput
              value={d.style.fontSize}
              min={8}
              max={48}
              onChange={(v) => st({ fontSize: v })}
            />
          </Field>
        </div>
        <Field label={t('drawings.text')}>
          <textarea
            className="ht-input dr-text"
            aria-label={t('drawings.drawingText')}
            value={d.style.text}
            rows={2}
            onChange={(e) => st({ text: e.target.value })}
          />
        </Field>
        <div className="dr-grid">
          <Checkbox
            checked={d.extendLeft}
            onChange={(v) => upd((x) => ({ ...x, extendLeft: v }))}
            label={t('drawings.extendLeft')}
          />
          <Checkbox
            checked={d.extendRight}
            onChange={(v) => upd((x) => ({ ...x, extendRight: v }))}
            label={t('drawings.extendRight')}
          />
          <Checkbox
            checked={d.showLabels}
            onChange={(v) => upd((x) => ({ ...x, showLabels: v }))}
            label={t('drawings.showLabels')}
          />
          <Checkbox
            checked={d.locked}
            onChange={(v) => upd((x) => ({ ...x, locked: v }))}
            label={t('drawings.locked')}
          />
          <Checkbox
            checked={d.sync}
            onChange={(v) => upd((x) => ({ ...x, sync: v }))}
            label={t('drawings.syncAll')}
          />
          <Checkbox
            checked={d.hidden}
            onChange={(v) => upd((x) => ({ ...x, hidden: v }))}
            label={t('drawings.hidden')}
          />
        </div>
        {d.type === 'emoji' && (
          <div>
            <div className="ht-menu-label">{t('drawings.emoji')}</div>
            <EmojiPicker
              value={prop<string>(d, 'glyph', '⭐')}
              onPick={(g) => setProp('glyph', g)}
            />
            <div className="dr-grid">
              <Field label={t('drawings.sizePx')}>
                <NumberInput
                  value={prop(d, 'size', 20)}
                  min={8}
                  max={96}
                  onChange={(v) => setProp('size', v)}
                />
              </Field>
            </div>
          </div>
        )}
        {canAlert && (
          <div className="dr-alert" data-testid="dr-alert-section">
            <div className="ht-menu-label">{t('drawings.alert')}</div>
            <Checkbox
              checked={d.alert}
              onChange={(v) => upd((x) => ({ ...x, alert: v }))}
              label={
                trigs.includes('cross') && trigs.length === 1
                  ? t('drawings.alertOnCross')
                  : t('drawings.alertTitle')
              }
            />
            {d.alert && (
              <div className="dr-grid">
                {trigs.length > 1 && (
                  <Field label={t('drawings.trigger')}>
                    <Select
                      aria-label={t('drawings.alertTrigger')}
                      value={alertTrigger(d)}
                      onChange={(v) => setProp('alertOn', v)}
                      options={ALERT_TRIGGERS.filter((t) => trigs.includes(t.value)).map((t) => ({
                        value: t.value,
                        label: t.label,
                      }))}
                    />
                  </Field>
                )}
                <Checkbox
                  checked={ch.toast}
                  onChange={(v) => setProp('alertToast', v)}
                  label={t('drawings.popup')}
                />
                <Checkbox
                  checked={ch.sound}
                  onChange={(v) => setProp('alertSound', v)}
                  label={t('drawings.sound')}
                />
                <Checkbox
                  checked={ch.log}
                  onChange={(v) => setProp('alertLog', v)}
                  label={t('drawings.activityLog')}
                />
                <Checkbox
                  checked={ch.once}
                  onChange={(v) => setProp('alertOnce', v)}
                  label={t('drawings.onlyOnce')}
                />
              </div>
            )}
          </div>
        )}
        {d.type === 'regression-channel' && (
          <div className="dr-grid">
            <Field label={t('drawings.outerSigma')}>
              <NumberInput
                value={prop(d, 'sigma', 2)}
                min={0.1}
                max={10}
                step={0.25}
                precision={2}
                onChange={(v) => setProp('sigma', v)}
              />
            </Field>
            <Field label={t('drawings.innerSigma')}>
              <NumberInput
                value={prop(d, 'sigma2', 0)}
                min={0}
                max={10}
                step={0.25}
                precision={2}
                onChange={(v) => setProp('sigma2', v)}
              />
            </Field>
          </div>
        )}
        {d.type === 'anchored-vwap' && (
          <div className="dr-grid">
            <Field label={t('drawings.band1Sigma')}>
              <NumberInput
                value={prop(d, 'band1', 1)}
                min={0}
                max={10}
                step={0.25}
                precision={2}
                onChange={(v) => setProp('band1', v)}
              />
            </Field>
            <Field label={t('drawings.band2Sigma')}>
              <NumberInput
                value={prop(d, 'band2', 2)}
                min={0}
                max={10}
                step={0.25}
                precision={2}
                onChange={(v) => setProp('band2', v)}
              />
            </Field>
          </div>
        )}
        {d.type === 'zigzag-vp' && (
          <div className="dr-grid">
            <Field label={t('drawings.reversal')}>
              <NumberInput
                value={prop(d, 'reversal', 20)}
                min={1}
                max={5000}
                onChange={(v) => setProp('reversal', v)}
              />
            </Field>
            <Checkbox
              checked={prop(d, 'showZigzag', true)}
              onChange={(v) => setProp('showZigzag', v)}
              label={t('drawings.showZigzag')}
            />
            <Checkbox
              checked={prop(d, 'legLabels', false)}
              onChange={(v) => setProp('legLabels', v)}
              label={t('drawings.legLabels')}
            />
          </div>
        )}
        {d.type === 'cvd-correlation' && (
          <div className="dr-grid">
            <Checkbox
              checked={prop(d, 'showCvd', true)}
              onChange={(v) => setProp('showCvd', v)}
              label={t('drawings.drawCvd')}
            />
            <Field label={t('drawings.weakCorr')}>
              <NumberInput
                value={prop(d, 'corrWarn', 0.3)}
                min={-1}
                max={1}
                step={0.05}
                precision={2}
                onChange={(v) => setProp('corrWarn', v)}
              />
            </Field>
          </div>
        )}
        {isPos && (
          <div className="dr-grid">
            <Field label={t('drawings.quantity')}>
              <NumberInput
                value={prop(d, 'qty', 1)}
                min={0}
                step={1}
                onChange={(v) => setProp('qty', v)}
              />
            </Field>
            <Field label={t('drawings.riskDollar')}>
              <NumberInput
                value={prop(d, 'risk', 0)}
                min={0}
                step={50}
                onChange={(v) => setProp('risk', v)}
              />
            </Field>
            <Button variant="outline" onClick={placeOrder}>
              {t('drawings.placeOrder')}
            </Button>
          </div>
        )}
        {isProfile && (
          <div className="dr-grid">
            <Field label={t('drawings.profile')}>
              <Select
                value={prop<string>(d, 'mode', 'volume')}
                onChange={(v) => setProp('mode', v)}
                options={[
                  { value: 'volume', label: t('drawings.volume') },
                  { value: 'tpo', label: t('drawings.tpo') },
                ]}
              />
            </Field>
            <Field label={t('drawings.valueArea')}>
              <NumberInput
                value={prop(d, 'va', 70)}
                min={10}
                max={100}
                step={5}
                onChange={(v) => setProp('va', v)}
              />
            </Field>
          </div>
        )}
        {levels && (
          <div className="dr-levels">
            <div className="ht-menu-label">{t('drawings.levels')}</div>
            {levels.map((l, i) => (
              <div key={i} className="dr-level">
                <input
                  type="checkbox"
                  aria-label={t('drawings.levelEnabled', { v: l.value })}
                  checked={l.enabled}
                  onChange={(e) =>
                    setLevels((ls) =>
                      ls.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)),
                    )
                  }
                />
                <NumberInput
                  value={l.value}
                  step={0.001}
                  precision={3}
                  onChange={(v) =>
                    setLevels((ls) => ls.map((x, k) => (k === i ? { ...x, value: v } : x)))
                  }
                />
                <input
                  type="color"
                  aria-label={t('drawings.levelColour', { v: l.value })}
                  value={(l.color || d.style.color).slice(0, 7)}
                  onChange={(e) =>
                    setLevels((ls) =>
                      ls.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)),
                    )
                  }
                />
                <button
                  className="dr-btn"
                  aria-label={t('drawings.removeLevel', { v: l.value })}
                  onClick={() => setLevels((ls) => ls.filter((_, k) => k !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              onClick={() => setLevels((ls) => [...ls, { value: 1, color: '', enabled: true }])}
            >
              {t('drawings.addLevel')}
            </Button>
          </div>
        )}
        <div>
          <div className="ht-menu-label">{t('drawings.visibleOn')}</div>
          <div className="dr-tfs">
            <Checkbox
              checked={allTf}
              onChange={(v) =>
                upd((x) => ({ ...x, visibleOn: v ? 'all' : [specKey(state.timeframe)] }))
              }
              label={t('drawings.all')}
            />
            {!allTf &&
              tfs.map((t) => (
                <Checkbox
                  key={t.key}
                  checked={(d.visibleOn as string[]).includes(t.key)}
                  onChange={(v) =>
                    upd((x) => {
                      const cur = x.visibleOn === 'all' ? [] : x.visibleOn;
                      return {
                        ...x,
                        visibleOn: v ? [...cur, t.key] : cur.filter((k) => k !== t.key),
                      };
                    })
                  }
                  label={t.label}
                />
              ))}
          </div>
        </div>
        <div className="row gap8">
          <Button variant="destructive" onClick={() => (removeSelection(windowId, id), close())}>
            {nSel > 1 ? t('drawings.deleteN', { n: nSel }) : t('drawings.delete')}
          </Button>
          <div className="grow" />
          <Button variant="primary" onClick={close}>
            {t('drawings.done')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Objects List window: every drawing of the active chart with show/hide/lock/delete/edit. */
export function ObjectsList(_props: ModuleViewProps) {
  // Re-render on window-state and selection changes.
  useWindows((s) => s.windows);
  useWindows((s) => s.activeId);
  const selected = useDrawUi((s) => s.selected);
  const multiSel = useDrawUi((s) => s.multi);
  const windowId = activeChartId();
  const win = windowId ? useWindows.getState().windows[windowId] : null;
  const items = windowId ? [...readDrawings(windowId)].sort((a, b) => b.z - a.z) : [];
  if (!windowId || win?.kind !== 'chart')
    return <div className="tbl-empty">{t('drawings.openChartToList')}</div>;
  return (
    <div className="col fill dr-objects" data-testid="objects-list">
      <div className="row gap8 dr-objects-head">
        <span className="muted">
          {instrumentOf(win.instrumentId)?.symbol ?? win.instrumentId} ·{' '}
          {t('drawings.objectsCount', { n: items.length, s: plural(items.length) })}
        </span>
        <div className="grow" />
        <Button size="xs" disabled={!items.length} onClick={() => mutate(windowId, () => [])}>
          {t('drawings.deleteAll')}
        </Button>
      </div>
      <div className="tbl-wrap">
        <table className="tbl tnum">
          <tbody>
            {items.map((d) => (
              <tr
                key={d.id}
                data-selected={
                  selected[windowId] === d.id || multiSel[windowId]?.includes(d.id) || undefined
                }
                onClick={(e) => {
                  const ui = useDrawUi.getState();
                  if (e.shiftKey || e.ctrlKey) {
                    const cur = selectionOf(windowId);
                    ui.selectMany(
                      windowId,
                      cur.includes(d.id) ? cur.filter((x) => x !== d.id) : [...cur, d.id],
                    );
                  } else ui.select(windowId, d.id);
                }}
              >
                <td>
                  <span className="dr-dot" style={{ background: d.style.color }} />
                  {nameOf(d, win.instrumentId)}
                </td>
                <td className="dr-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="dr-btn"
                    aria-label={d.hidden ? t('drawings.show') : t('drawings.hide')}
                    title={d.hidden ? t('drawings.show') : t('drawings.hide')}
                    onClick={() => patchOne(windowId, d.id, (x) => ({ ...x, hidden: !x.hidden }))}
                  >
                    {d.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    className="dr-btn"
                    aria-label={d.locked ? t('drawings.unlock') : t('drawings.lock')}
                    title={d.locked ? t('drawings.unlock') : t('drawings.lock')}
                    onClick={() => patchOne(windowId, d.id, (x) => ({ ...x, locked: !x.locked }))}
                  >
                    {d.locked ? <Lock size={13} /> : <Unlock size={13} />}
                  </button>
                  <button
                    className="dr-btn"
                    aria-label={t('drawings.edit')}
                    title={t('drawings.editEllipsis')}
                    onClick={() => useDrawUi.getState().edit({ windowId, id: d.id })}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="dr-btn"
                    aria-label={t('drawings.delete')}
                    title={t('drawings.delete')}
                    onClick={() => removeOne(windowId, d.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="tbl-empty">{t('drawings.noDrawings')}</div>}
      </div>
    </div>
  );
}

/** Drawing preferences: magnet (presets + pixel slider), snap, keep drawing, toolbar, magnifier. */
function PrefsDialog({ windowId }: { windowId: string }) {
  const p = useDrawUi((s) => s.prefs);
  const set = useDrawUi.getState().setPrefs;
  const lens = useDrawUi((s) => !!s.lens[windowId]);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && useDrawUi.getState().openPrefs(false)}
      title={t('drawings.prefsTitle')}
      width={420}
    >
      <div className="col gap12 dr-props" data-testid="drawing-prefs">
        <Checkbox
          checked={p.magnet}
          onChange={(v) => set({ magnet: v })}
          label={t('drawings.magnetOhlc')}
        />
        <Field label={t('drawings.magnetSensitivityPx', { px: p.magnetPx })}>
          <div className="row gap8">
            <Slider
              label={t('drawings.magnetSensitivity')}
              value={p.magnetPx}
              min={2}
              max={40}
              step={1}
              onChange={(v) => set({ magnet: true, magnetPx: v })}
            />
            <NumberInput
              value={p.magnetPx}
              min={2}
              max={40}
              onChange={(v) => set({ magnet: true, magnetPx: v })}
            />
          </div>
        </Field>
        <div className="row gap8 dr-presets" role="group" aria-label={t('drawings.magnetPresets')}>
          <Button size="xs" aria-pressed={!p.magnet} onClick={() => set({ magnet: false })}>
            {t('drawings.off')}
          </Button>
          {[4, 8, 12, 16, 24].map((n) => (
            <Button
              key={n}
              size="xs"
              aria-pressed={p.magnet && p.magnetPx === n}
              onClick={() => set({ magnet: true, magnetPx: n })}
            >
              {t('drawings.px', { n })}
            </Button>
          ))}
        </div>
        <div className="dr-grid">
          <Checkbox
            checked={p.snapTicks}
            onChange={(v) => set({ snapTicks: v })}
            label={t('drawings.snapToTicks')}
          />
          <Checkbox
            checked={p.keep}
            onChange={(v) => set({ keep: v })}
            label={t('drawings.keepDrawingPrefs')}
          />
          <Checkbox
            checked={p.toolbar}
            onChange={(v) => set({ toolbar: v })}
            label={t('drawings.styleToolbar')}
          />
          <Checkbox
            checked={lens}
            onChange={() => runToolCommand('magnifier', windowId)}
            label={t('drawings.magnifierOn')}
          />
        </div>
        <Field label={t('drawings.magnifierZoom', { z: p.lensZoom })}>
          <Slider
            label={t('drawings.magnifierZoomLabel')}
            value={p.lensZoom}
            min={1.5}
            max={8}
            step={0.5}
            onChange={(v) => set({ lensZoom: v })}
          />
        </Field>
        <Field label={t('drawings.magnifierSize', { px: p.lensSize })}>
          <Slider
            label={t('drawings.magnifierSizeLabel')}
            value={p.lensSize}
            min={60}
            max={300}
            step={10}
            onChange={(v) => set({ lensSize: v })}
          />
        </Field>
        <div className="row gap8">
          <div className="grow" />
          <Button variant="primary" onClick={() => useDrawUi.getState().openPrefs(false)}>
            {t('drawings.done')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
