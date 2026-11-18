import { useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  BUILTIN_TEMPLATES,
  builtinTemplate,
  columnDef,
  duplicateTemplate,
  moveColumn,
  parseTemplates,
  resizeColumn,
  serializeTemplates,
  setColumnColors,
  toggleColumn,
  uniqueName,
  type CentringMode,
  type DomColumnConfig,
  type DomPaletteSpec,
  type DomTemplate,
} from '@htflow/dom';
import {
  Button,
  Checkbox,
  ColorPicker,
  Dialog,
  Field,
  FontPicker,
  Input,
  NumberInput,
  SegmentedControl,
  Select,
  Slider,
  SplitPane,
  Table,
  Tabs,
  Toggle,
  toast,
  type TableColumn,
} from '@htflow/ui-kit';
import { domStore, useDomStore } from './store';
import { setWindowTemplate } from './controllers';

import { translateLiteral as tl } from '@htflow/i18n';
interface DesignerTarget {
  windowId: string;
  templateId?: string;
  mode?: 'edit' | 'new';
}

const useDesignerState = create<{ target: DesignerTarget | null }>(() => ({ target: null }));

export function openDesigner(t: DesignerTarget): void {
  useDesignerState.setState({ target: t });
}

export function closeDesigner(): void {
  useDesignerState.setState({ target: null });
}

export const useDesigner = (): DesignerTarget | null => useDesignerState((s) => s.target);

const PALETTE_LABELS: Record<keyof DomPaletteSpec, string> = {
  bg: 'Background',
  rowAlt: 'Alternate row',
  grid: 'Grid lines',
  header: 'Header',
  headerText: 'Header text',
  text: 'Text',
  textDim: 'Dim text',
  priceBg: 'Price column',
  lastBg: 'Last price row',
  bid: 'Bid',
  ask: 'Ask',
  buy: 'Buys / profit',
  sell: 'Sells / loss',
  volume: 'Volume bars',
  order: 'Working orders',
  position: 'Position average',
  pulled: 'Pulled flash',
  stacked: 'Stacked flash',
  iceberg: 'Iceberg marker',
  va: 'Value area',
  poc: 'POC',
  note: 'Notes',
  spread: 'Spread line',
};

type Tab = 'columns' | 'style' | 'behaviour';

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Smart DOM template designer (P15): template list (new, duplicate, rename, delete / reset,
 * export, import) and an editor for columns (order, visibility, width, colours), style (font,
 * row height, centring, palette) and behaviour (volume scope, flash thresholds, lot presets).
 */
export function TemplateDesigner() {
  useDomStore();
  const target = useDesigner()!;
  const all = domStore.templates();
  const startId = target.templateId ?? all[0]!.id;
  const [selId, setSelId] = useState(startId);
  const [draft, setDraft] = useState<DomTemplate>(() =>
    target.mode === 'new'
      ? duplicateTemplate(
          domStore.get(startId),
          domStore.newId(),
          all.map((t) => t.name),
        )
      : domStore.get(startId),
  );
  const [isNew, setIsNew] = useState(target.mode === 'new');
  const [tab, setTab] = useState<Tab>('columns');
  const fileRef = useRef<HTMLInputElement>(null);
  const names = all.map((t) => t.name);

  const select = (id: string) => {
    setSelId(id);
    setDraft(domStore.get(id));
    setIsNew(false);
  };
  const startCopy = (from: DomTemplate) => {
    const d = duplicateTemplate(from, domStore.newId(), names);
    setDraft(d);
    setSelId(d.id);
    setIsNew(true);
  };
  const save = (apply: boolean) => {
    const name = draft.name.trim() || 'Untitled';
    const clash = all.some((t) => t.id !== draft.id && t.name === name);
    const t = { ...draft, name: clash ? uniqueName(name, names) : name };
    domStore.save(t);
    setDraft(t);
    setSelId(t.id);
    setIsNew(false);
    if (apply) setWindowTemplate(target.windowId, t.id);
    toast('success', `Template “${t.name}” saved`);
  };
  const remove = () => {
    const cur = all.find((t) => t.id === selId);
    if (!cur) return;
    domStore.remove(cur.id);
    if (cur.builtin) {
      setDraft(builtinTemplate(cur.id)!);
      toast('info', `“${cur.name}” reset to default`);
    } else {
      select(BUILTIN_TEMPLATES[0]!.id);
      toast('info', `Template “${cur.name}” deleted`);
    }
  };
  const doImport = async (file: File) => {
    try {
      const list = parseTemplates(await file.text(), () => domStore.newId());
      const taken = [...names];
      for (const t of list) {
        const n = uniqueName(t.name, taken);
        taken.push(n);
        domStore.save({ ...t, name: n });
      }
      select(list[0]!.id);
      toast('success', `Imported ${list.length} template${list.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast('error', tl('Import failed'), (e as Error).message);
    }
  };

  const selected = all.find((t) => t.id === selId);
  const listCols: TableColumn<DomTemplate>[] = [
    { key: 'name', header: 'Template', render: (t) => t.name },
    {
      key: 'kind',
      header: 'Kind',
      width: 70,
      render: (t) => (t.builtin ? (domStore.isEdited(t.id) ? 'Edited' : 'Built-in') : 'Custom'),
    },
  ];
  const rows = isNew ? [...all, draft] : all;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && closeDesigner()}
      title={tl('DOM template designer')}
      width={1040}
    >
      <div className="sdom-designer" data-testid="dom-designer">
        <SplitPane defaultRatio={0.3} minA={220} minB={480} aria-label={tl('Resize template list')}>
          <div className="sdom-d-list">
            <Table
              aria-label={tl('DOM templates')}
              columns={listCols}
              rows={rows}
              rowId={(t) => t.id}
              height={380}
              selectionMode="single"
              selected={new Set([selId])}
              onSelectionChange={(ids) => {
                const id = [...ids][0];
                if (id && id !== selId && !(isNew && id === draft.id)) select(id);
              }}
            />
            <div className="sdom-d-actions">
              <Button size="sm" onClick={() => startCopy(BUILTIN_TEMPLATES[1]!)}>
                {tl('New')}
              </Button>
              <Button size="sm" onClick={() => startCopy(draft)}>
                {tl('Duplicate')}
              </Button>
              <Button
                size="sm"
                disabled={
                  isNew || !selected || (selected.builtin && !domStore.isEdited(selected.id))
                }
                onClick={remove}
              >
                {selected?.builtin ? 'Reset' : 'Delete'}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  download(
                    `${draft.name.replace(/[^\w.-]+/g, '_')}.dom-template.json`,
                    serializeTemplates([draft]),
                  )
                }
              >
                {tl('Export')}
              </Button>
              <Button
                size="sm"
                onClick={() => download('dom-templates.json', serializeTemplates(all))}
              >
                {tl('Export all')}
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                {tl('Import…')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                data-testid="dom-template-import"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
          <div className="sdom-d-edit">
            <Field label={tl('Name')}>
              <Input
                aria-label={tl('Template name')}
                value={draft.name}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'columns', label: 'Columns' },
                { value: 'style', label: 'Style' },
                { value: 'behaviour', label: 'Behaviour' },
              ]}
            />
            <div className="sdom-d-body">
              {tab === 'columns' && <ColumnsEditor draft={draft} setDraft={setDraft} />}
              {tab === 'style' && <StyleEditor draft={draft} setDraft={setDraft} />}
              {tab === 'behaviour' && <BehaviourEditor draft={draft} setDraft={setDraft} />}
            </div>
            <div className="sdom-d-foot">
              <span className="grow muted">
                {draft.builtin ? 'Built-in: saving keeps your edits; Reset restores it.' : ''}
              </span>
              <Button variant="ghost" onClick={closeDesigner}>
                {tl('Close')}
              </Button>
              <Button onClick={() => save(false)}>{tl('Save')}</Button>
              <Button variant="primary" onClick={() => save(true)}>
                Save &amp; apply
              </Button>
            </div>
          </div>
        </SplitPane>
      </div>
    </Dialog>
  );
}

interface EditorProps {
  draft: DomTemplate;
  setDraft: (t: DomTemplate) => void;
}

function OptColor({
  value,
  label,
  fallback,
  onChange,
}: {
  value: string | undefined;
  label: string;
  fallback: string;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div className="sdom-optcolor">
      <ColorPicker label={label} value={value ?? fallback} onChange={(v) => onChange(v)} />
      {value && (
        <button
          className="ht-icon-btn"
          aria-label={`Clear ${label}`}
          onClick={() => onChange(undefined)}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function ColumnsEditor({ draft, setDraft }: EditorProps) {
  const p = draft.style.palette;
  const cols: TableColumn<DomColumnConfig>[] = useMemo(
    () => [
      {
        key: 'visible',
        header: 'Show',
        width: 46,
        render: (c) => (
          <Checkbox
            label=""
            checked={c.visible}
            onChange={(v) => setDraft(toggleColumn(draft, c.id, v))}
          />
        ),
      },
      {
        key: 'label',
        header: 'Column',
        render: (c) => <span title={columnDef(c.id).description}>{columnLabel(c.id)}</span>,
      },
      {
        key: 'width',
        header: 'Width',
        width: 112,
        render: (c) => (
          <NumberInput
            aria-label={`${columnLabel(c.id)} width`}
            value={c.width}
            min={24}
            max={400}
            unit="px"
            onChange={(v) => setDraft(resizeColumn(draft, c.id, v))}
          />
        ),
      },
      ...(['bg', 'fg', 'accent'] as const).map((k) => ({
        key: k,
        header: k === 'bg' ? 'Background' : k === 'fg' ? 'Text' : 'Bars / accent',
        width: 128,
        render: (c: DomColumnConfig) => (
          <OptColor
            label={`${columnLabel(c.id)} ${k === 'bg' ? 'background' : k === 'fg' ? 'text' : 'accent'}`}
            value={c[k]}
            fallback={k === 'bg' ? p.bg : k === 'fg' ? p.text : p.volume}
            onChange={(v) => setDraft(setColumnColors(draft, c.id, { [k]: v }))}
          />
        ),
      })),
      {
        key: 'order',
        header: 'Order',
        width: 60,
        render: (c) => {
          const i = draft.columns.findIndex((x) => x.id === c.id);
          return (
            <span className="row gap4">
              <button
                className="ht-icon-btn"
                aria-label={`Move ${columnLabel(c.id)} up`}
                disabled={i === 0}
                onClick={() => setDraft(moveColumn(draft, c.id, draft.columns[i - 1]!.id))}
              >
                <ArrowUp size={12} />
              </button>
              <button
                className="ht-icon-btn"
                aria-label={`Move ${columnLabel(c.id)} down`}
                disabled={i === draft.columns.length - 1}
                onClick={() => setDraft(moveColumn(draft, c.id, draft.columns[i + 2]?.id ?? null))}
              >
                <ArrowDown size={12} />
              </button>
            </span>
          );
        },
      },
    ],
    [draft, setDraft, p],
  );
  return (
    <Table
      aria-label={tl('Template columns')}
      columns={cols}
      rows={draft.columns}
      rowId={(c) => c.id}
      rowHeight={30}
      height={360}
    />
  );
}

const columnLabel = (id: DomColumnConfig['id']) =>
  id === 'bidChg' ? 'Limit Δ (bid)' : id === 'askChg' ? 'Limit Δ (ask)' : columnDef(id).label;

function StyleEditor({ draft, setDraft }: EditorProps) {
  const s = draft.style;
  const set = (p: Partial<DomTemplate['style']>) => setDraft({ ...draft, style: { ...s, ...p } });
  return (
    <div className="sdom-d-grid">
      <Field label={tl('Font')}>
        <FontPicker value={s.fontFamily} onChange={(f) => set({ fontFamily: f })} />
      </Field>
      <Field label={tl('Font size')}>
        <NumberInput
          aria-label={tl('Font size')}
          value={s.fontSize}
          min={8}
          max={20}
          unit="px"
          onChange={(v) => set({ fontSize: v })}
        />
      </Field>
      <Field label={tl('Row height')}>
        <NumberInput
          aria-label={tl('Row height')}
          value={s.rowHeight}
          min={12}
          max={40}
          unit="px"
          onChange={(v) => set({ rowHeight: v })}
        />
      </Field>
      <Field label={tl('Header height')}>
        <NumberInput
          aria-label={tl('Header height')}
          value={s.headerHeight}
          min={14}
          max={40}
          unit="px"
          onChange={(v) => set({ headerHeight: v })}
        />
      </Field>
      <Field
        label={tl('Centring')}
        hint={tl(
          'Auto re-centres when price leaves the middle band; Always keeps it centred; Manual only on C / double-click.',
        )}
      >
        <Select<CentringMode>
          aria-label={tl('Centring')}
          value={s.centring}
          onChange={(v) => set({ centring: v })}
          options={[
            { value: 'auto', label: 'Auto (band)' },
            { value: 'always', label: 'Always centred' },
            { value: 'manual', label: 'Manual' },
          ]}
        />
      </Field>
      <Field label={`Centre band ${Math.round(s.centreBand * 100)} %`}>
        <Slider
          label={tl('Centre band')}
          value={s.centreBand}
          min={0.05}
          max={0.45}
          step={0.05}
          onChange={(v) => set({ centreBand: v })}
        />
      </Field>
      <Field label={tl('Grid lines')}>
        <Toggle
          label={tl('Grid lines')}
          checked={s.gridLines}
          onChange={(v) => set({ gridLines: v })}
        />
      </Field>
      <div className="sdom-d-palette">
        {(Object.keys(PALETTE_LABELS) as (keyof DomPaletteSpec)[]).map((k) => (
          <label key={k} className="sdom-d-pal">
            <span>{PALETTE_LABELS[k]}</span>
            <ColorPicker
              label={PALETTE_LABELS[k]}
              value={s.palette[k]}
              onChange={(v) => set({ palette: { ...s.palette, [k]: v } })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function BehaviourEditor({ draft, setDraft }: EditorProps) {
  const b = draft.behaviour;
  const set = (p: Partial<DomTemplate['behaviour']>) =>
    setDraft({ ...draft, behaviour: { ...b, ...p } });
  const [lots, setLots] = useState(b.lotPresets.join(', '));
  const num = (
    label: string,
    key: keyof DomTemplate['behaviour'],
    min: number,
    max: number,
    unit?: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <NumberInput
        aria-label={label}
        value={b[key] as number}
        min={min}
        max={max}
        unit={unit}
        onChange={(v) => set({ [key]: v } as Partial<DomTemplate['behaviour']>)}
      />
    </Field>
  );
  return (
    <div className="sdom-d-grid">
      <Field label={tl('Volume / delta / VA source')}>
        <SegmentedControl
          value={b.volumeScope}
          onChange={(v) => set({ volumeScope: v })}
          options={[
            { value: 'session', label: 'Session' },
            { value: 'range', label: 'Rolling range' },
          ]}
        />
      </Field>
      {num('Range length', 'rangeMinutes', 1, 1440, 'min')}
      {num('Buys / Sells window', 'recentSeconds', 1, 600, 's')}
      {num('Limit Δ window', 'limitSeconds', 1, 600, 's')}
      {num(
        'Pulled threshold',
        'pulledThreshold',
        0,
        1e9,
        'lots',
        'Size removed in one update (not fills) that flashes. 0 = off.',
      )}
      {num(
        'Stacked threshold',
        'stackedThreshold',
        0,
        1e9,
        'lots',
        'Size added in one update that flashes. 0 = off.',
      )}
      {num('Flash duration', 'flashMs', 100, 10_000, 'ms')}
      {num(
        'Iceberg refills',
        'icebergMinRefills',
        1,
        50,
        '×',
        'Refills after fills at one price before it is marked.',
      )}
      {num(
        'Big size highlight',
        'bigSize',
        0,
        1e12,
        'lots',
        '0 = use Settings → DOM big-lot threshold.',
      )}
      <Field label={tl('Lot presets')} hint={tl('Comma-separated, up to 8.')}>
        <Input
          aria-label={tl('Lot presets')}
          value={lots}
          onChange={(e) => setLots(e.target.value)}
          onBlur={() => {
            const v = lots
              .split(/[,\s]+/)
              .map(Number)
              .filter((x) => Number.isFinite(x) && x > 0)
              .slice(0, 8);
            if (v.length) set({ lotPresets: v });
            setLots((v.length ? v : b.lotPresets).join(', '));
          }}
        />
      </Field>
      <Field label={tl('Show risk limits in header')}>
        <Toggle
          label={tl('Show risk limits')}
          checked={b.showRiskLimits}
          onChange={(v) => set({ showRiskLimits: v })}
        />
      </Field>
    </div>
  );
}
