import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Plus, Star, Trash2, X } from 'lucide-react';
import {
  CATEGORIES,
  PANE_HEIGHT,
  SOURCES,
  TF_CLASSES,
  TIMEFRAMES,
  createConfig,
  newUid,
  resolveInputs,
  resolveStyles,
  titleOf,
  type AnyIndicator,
  type IndicatorCategory,
  type IndicatorConfig,
  type InputDef,
  type InputValue,
  type OutputStyle,
} from '@htflow/indicator-sdk';
import { CATALOG, indicatorById, isImplemented, type CatalogEntry } from '@htflow/indicators';
import { t } from '@htflow/i18n';
import {
  Badge,
  Button,
  Checkbox,
  ColorSwatch,
  Dialog,
  Input,
  NumberInput,
  Select,
  Slider,
  Tabs,
  Toggle,
  toast,
} from '@htflow/ui-kit';
import { specLabel, type BarSpec } from '@htflow/market-data';
import type { ChartWindowState } from '@htflow/workspace';
import { backend } from '../../backend';
import { useWindows } from '../../state/windows';
import { instrumentById } from '../../state/instruments';
import { readExt, useIndicatorDialog, writeExt } from './state';

type Tab = 'inputs' | 'style' | 'alerts' | 'visibility' | 'advanced';
type Preset = { name: string; inputs: IndicatorConfig['inputs']; styles: IndicatorConfig['styles'] };

const FAV_KEY = 'indicators.favourites';
const PRESET_KEY = 'indicators.presets';
const DEFAULT_FAVS = [
  'volume-orderflow:big-trades',
  'volume-orderflow:cumulative-delta',
  'volume-orderflow:vwap',
  'volume-orderflow:stacked-imbalance',
  'volume-orderflow:delta',
  'technical:ema',
  'technical:rsi',
  'technical:bollinger-bands',
];

const catLabel = (c: IndicatorCategory) => CATEGORIES.find((x) => x.id === c)?.label ?? c;

export function IndicatorsDialog({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  const close = useIndicatorDialog((s) => s.close);
  const initialSelect = useIndicatorDialog((s) => s.select);
  const original = useRef(readExt(windowId).items);
  const [draft, setDraftRaw] = useState<IndicatorConfig[]>(original.current);
  const [sel, setSel] = useState<string | null>(initialSelect ?? original.current[0]?.uid ?? null);
  const [cat, setCat] = useState<IndicatorCategory | 'favourites'>('favourites');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('inputs');
  const [favs, setFavs] = useState<string[]>(DEFAULT_FAVS);
  const [presets, setPresets] = useState<Record<string, Preset[]>>({});
  const [presetName, setPresetName] = useState<string | null>(null);

  useEffect(() => {
    void backend.loadSettings<string[]>(FAV_KEY).then((f) => Array.isArray(f) && setFavs(f));
    void backend.loadSettings<Record<string, Preset[]>>(PRESET_KEY).then((p) => p && typeof p === 'object' && setPresets(p));
  }, []);

  // Live preview: every change is written to the chart; Cancel restores the original list.
  const setDraft = (next: IndicatorConfig[]) => {
    setDraftRaw(next);
    writeExt(windowId, next);
  };
  const cancel = () => {
    writeExt(windowId, original.current);
    close();
  };

  const selected = draft.find((c) => c.uid === sel) ?? null;
  const def = selected ? indicatorById(selected.type) : undefined;
  const update = (patch: Partial<IndicatorConfig>) =>
    selected && setDraft(draft.map((c) => (c.uid === selected.uid ? { ...c, ...patch } : c)));

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of CATALOG) m[e.category] = (m[e.category] ?? 0) + 1;
    return m;
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return CATALOG.filter((e) => e.name.toLowerCase().includes(q));
    if (cat === 'favourites') return CATALOG.filter((e) => favs.includes(e.key));
    return CATALOG.filter((e) => e.category === cat);
  }, [cat, query, favs]);

  const toggleFav = (key: string) => {
    const next = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
    setFavs(next);
    void backend.saveSettings(FAV_KEY, next);
  };

  const add = (e: CatalogEntry) => {
    const d = e.impl ? indicatorById(e.impl) : undefined;
    if (!d) return;
    const cfg = createConfig(d);
    cfg.inputs = { ...resolveInputs(d.inputs, { ...cfg.inputs, ...e.inputs }) };
    setDraft([...draft, cfg]);
    setSel(cfg.uid);
    setTab('inputs');
  };

  const move = (uid: string, dir: -1 | 1) => {
    const i = draft.findIndex((c) => c.uid === uid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= draft.length) return;
    const next = draft.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    setDraft(next);
  };

  const paneLabel = (c: IndicatorConfig) => {
    if (c.pane === 'overlay') return 'Overlay';
    let n = 1;
    for (const x of draft) {
      if (x.pane === 'new') n++;
      if (x.uid === c.uid) break;
    }
    return c.pane === 'new' ? `Pane ${n}` : `Pane (shared)`;
  };

  const savePreset = () => {
    if (!selected || !presetName?.trim()) return;
    const name = presetName.trim().slice(0, 40);
    const forType = (presets[selected.type] ?? []).filter((p) => p.name !== name);
    const next = { ...presets, [selected.type]: [...forType, { name, inputs: selected.inputs, styles: selected.styles }] };
    setPresets(next);
    setPresetName(null);
    void backend.saveSettings(PRESET_KEY, next);
    toast('success', `Preset "${name}" saved`);
  };

  const applyAll = () => {
    if (!selected) return;
    const windows = useWindows.getState().windows;
    let n = 0;
    for (const [id, w] of Object.entries(windows)) {
      if (id === windowId || w.kind !== 'chart') continue;
      const items = readExt(id).items;
      const k = items.findIndex((c) => c.type === selected.type);
      const copy = { ...selected, pane: selected.pane === 'overlay' ? 'overlay' : 'new' };
      if (k >= 0) items[k] = { ...copy, uid: items[k]!.uid, enabled: items[k]!.enabled };
      else items.push({ ...copy, uid: newUid() });
      writeExt(id, items);
      n++;
    }
    toast('success', `${titleOf(def!, selected.inputs)} applied to ${n} chart${n === 1 ? '' : 's'}`);
  };

  const inst = instrumentById(state.instrumentId);
  const total = CATALOG.length;
  const noBars = state.template === 'liquidity-map';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && cancel()}
      title={t('indicators.title')}
      description={`${inst?.symbol ?? state.instrumentId} · ${specLabel(state.timeframe as BarSpec)} · ${t('indicators.available', { n: total })}`}
      width={1180}
    >
      <div className="ind-dlg" onContextMenu={(e) => e.stopPropagation()} data-testid="indicators-dialog">
        <input
          className="ht-input ind-search"
          placeholder={t('indicators.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('indicators.search')}
        />
        <button className="ht-icon-btn ind-close" aria-label="Close" onClick={cancel}>
          <X size={16} />
        </button>
        <div className="ind-cols">
          <nav className="ind-cats" aria-label="Categories">
            <button aria-pressed={cat === 'favourites' && !query} onClick={() => (setCat('favourites'), setQuery(''))}>
              {t('indicators.favourites')}
              <span className="tnum">{favs.length}</span>
            </button>
            {CATEGORIES.map((c) => (
              <button key={c.id} aria-pressed={cat === c.id && !query} onClick={() => (setCat(c.id), setQuery(''))}>
                {c.label}
                <span className="tnum">{counts[c.id] ?? 0}</span>
              </button>
            ))}
          </nav>
          <section className="ind-mid">
            <div className="ind-catalog" data-testid="indicator-catalog">
              <div className="ind-head">{query ? `Search: ${list.length}` : cat === 'favourites' ? 'Favourites' : catLabel(cat)}</div>
              {list.map((e, k) => {
                const ok = isImplemented(e);
                const showGroup = e.group && !query && cat !== 'favourites' && list[k - 1]?.group !== e.group;
                return (
                  <div key={e.key}>
                    {showGroup && <div className="ind-group">{e.group}</div>}
                    <div className={`ind-row ${ok ? '' : 'ind-row--pending'}`} title={e.note ?? (ok ? indicatorById(e.impl!)?.description : '')}>
                      <button
                        className="ind-star"
                        aria-label={`Favourite ${e.name}`}
                        data-on={favs.includes(e.key) || undefined}
                        onClick={() => toggleFav(e.key)}
                      >
                        <Star size={12} />
                      </button>
                      <span className="ind-name">{e.name}</span>
                      {ok ? (
                        <button className="ht-icon-btn" aria-label={`Add ${e.name}`} disabled={noBars} onClick={() => add(e)}>
                          <Plus size={13} />
                        </button>
                      ) : (
                        <Badge>{t('indicators.pending')}</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="ind-chart">
              <div className="ind-head">{t('indicators.onChart', { n: draft.length })}</div>
              {noBars && <p className="muted ind-note">{t('indicators.noBars')}</p>}
              {draft.map((c) => {
                const d = indicatorById(c.type);
                if (!d) return null;
                return (
                  <div key={c.uid} className="ind-row ind-inst" aria-selected={c.uid === sel} onClick={() => setSel(c.uid)}>
                    <button
                      className="ht-icon-btn"
                      aria-label={c.enabled ? 'Hide' : 'Show'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDraft(draft.map((x) => (x.uid === c.uid ? { ...x, enabled: !x.enabled } : x)));
                      }}
                    >
                      {c.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                    <span className="ind-name" data-off={!c.enabled || undefined}>
                      {titleOf(d, c.inputs)}
                    </span>
                    <span className="ind-pane">{paneLabel(c)}</span>
                    <span className="ind-acts">
                      <button className="ht-icon-btn" aria-label="Move up" onClick={(e) => (e.stopPropagation(), move(c.uid, -1))}>
                        <ArrowUp size={12} />
                      </button>
                      <button className="ht-icon-btn" aria-label="Move down" onClick={(e) => (e.stopPropagation(), move(c.uid, 1))}>
                        <ArrowDown size={12} />
                      </button>
                      <button
                        className="ht-icon-btn"
                        aria-label="Duplicate"
                        onClick={(e) => {
                          e.stopPropagation();
                          const copy = { ...c, uid: newUid() };
                          setDraft([...draft, copy]);
                          setSel(copy.uid);
                        }}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        className="ht-icon-btn"
                        aria-label="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraft(draft.filter((x) => x.uid !== c.uid).map((x) => (x.pane === c.uid ? { ...x, pane: 'new' } : x)));
                          if (sel === c.uid) setSel(null);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="ind-settings">
            {!selected || !def ? (
              <p className="muted ind-note">{t('indicators.empty')}</p>
            ) : (
              <>
                <div className="ind-set-head">
                  <h3>{def.name}</h3>
                  <Badge>{catLabel(def.category)}</Badge>
                  <div className="grow" />
                  <Select
                    small
                    aria-label="Preset"
                    value=""
                    onChange={(name) => {
                      if (name === '__default') update({ inputs: { ...resolveInputs(def.inputs, undefined) }, styles: resolveStyles(def, undefined) });
                      const p = presets[selected.type]?.find((x) => x.name === name);
                      if (p) update({ inputs: { ...resolveInputs(def.inputs, p.inputs) }, styles: resolveStyles(def, p.styles) });
                    }}
                    options={[
                      { value: '', label: 'Preset…' },
                      { value: '__default', label: 'Default' },
                      ...(presets[selected.type] ?? []).map((p) => ({ value: p.name, label: `${p.name} (saved)` })),
                    ]}
                  />
                </div>
                {def.formula && <p className="ind-formula mono">{def.formula}</p>}
                <Tabs<Tab>
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { value: 'inputs', label: 'Inputs' },
                    { value: 'style', label: 'Style' },
                    { value: 'alerts', label: 'Alerts' },
                    { value: 'visibility', label: 'Visibility' },
                    { value: 'advanced', label: 'Advanced' },
                  ]}
                />
                <div className="ind-body">
                  {tab === 'inputs' && <InputsTab def={def} cfg={selected} onChange={(inputs) => update({ inputs })} />}
                  {tab === 'style' && <StyleTab def={def} cfg={selected} onChange={(styles) => update({ styles })} />}
                  {tab === 'alerts' && <p className="muted">{t('indicators.alertsPending')}</p>}
                  {tab === 'visibility' && (
                    <div className="ind-grid2">
                      {TF_CLASSES.map((c) => (
                        <Checkbox
                          key={c.value}
                          label={c.label}
                          checked={selected.visibility.includes(c.value)}
                          onChange={(on) =>
                            update({
                              visibility: on
                                ? [...selected.visibility, c.value]
                                : selected.visibility.filter((x) => x !== c.value),
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                  {tab === 'advanced' && <AdvancedTab cfg={selected} draft={draft} update={update} />}
                </div>
                <div className="ind-foot">
                  <Button variant="ghost" size="sm" onClick={() => update({ inputs: { ...resolveInputs(def.inputs, undefined) }, styles: resolveStyles(def, undefined) })}>
                    {t('indicators.reset')}
                  </Button>
                  {presetName === null ? (
                    <Button variant="outline" size="sm" onClick={() => setPresetName('')}>
                      {t('indicators.savePreset')}
                    </Button>
                  ) : (
                    <span className="ind-preset">
                      <Input
                        autoFocus
                        aria-label="Preset name"
                        placeholder="Preset name"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && savePreset()}
                      />
                      <Button size="sm" variant="outline" onClick={savePreset}>
                        Save
                      </Button>
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={applyAll}>
                    {t('indicators.applyAll')}
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
        <div className="ind-actions">
          <Button variant="ghost" onClick={cancel}>
            {t('indicators.cancel')}
          </Button>
          <Button variant="primary" data-testid="indicators-apply" onClick={close}>
            {t('indicators.apply')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="ind-field" title={help}>
      <span className="ind-label">{label}</span>
      <div className="ind-control">{children}</div>
      {help && <span className="ind-help">{help}</span>}
    </div>
  );
}

function InputControl({ d, value, onChange }: { d: InputDef; value: InputValue; onChange: (v: InputValue) => void }) {
  switch (d.type) {
    case 'int':
    case 'float':
      return (
        <NumberInput
          aria-label={d.label}
          value={value as number}
          min={d.min}
          max={d.max}
          step={d.step}
          precision={d.type === 'int' ? 0 : Math.max(2, (String(d.step).split('.')[1] ?? '').length)}
          unit={d.unit}
          onChange={onChange}
        />
      );
    case 'bool':
      return <Toggle label={d.label} checked={value as boolean} onChange={onChange} />;
    case 'enum':
      return <Select aria-label={d.label} value={value as string} onChange={onChange} options={d.options.map((o) => ({ ...o }))} />;
    case 'color':
      return <ColorSwatch label={d.label} value={value as string} onChange={onChange} />;
    case 'linestyle':
      return (
        <Select
          aria-label={d.label}
          value={value as string}
          onChange={onChange}
          options={['solid', 'dashed', 'dotted'].map((v) => ({ value: v, label: v }))}
        />
      );
    case 'source':
      return (
        <Select
          aria-label={d.label}
          value={value as string}
          onChange={onChange}
          options={SOURCES.filter((s) => !d.sources || d.sources.includes(s.value)).map((s) => ({ value: s.value, label: s.label }))}
        />
      );
    case 'timeframe':
      return (
        <Select
          aria-label={d.label}
          value={value as string}
          onChange={onChange}
          options={TIMEFRAMES.filter((s) => !d.options || d.options.includes(s.value)).map((s) => ({ ...s }))}
        />
      );
    case 'string':
      return <Input aria-label={d.label} value={value as string} maxLength={d.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
}

function InputsTab({ def, cfg, onChange }: { def: AnyIndicator; cfg: IndicatorConfig; onChange: (v: IndicatorConfig['inputs']) => void }) {
  const vals = resolveInputs(def.inputs, cfg.inputs) as Record<string, InputValue>;
  const entries = Object.entries(def.inputs);
  if (!entries.length) return <p className="muted">This indicator has no inputs.</p>;
  return (
    <div className="ind-form">
      {entries.map(([k, d]) => (
        <Row key={k} label={d.label} help={d.help}>
          <InputControl d={d} value={vals[k]!} onChange={(v) => onChange({ ...vals, [k]: v })} />
        </Row>
      ))}
    </div>
  );
}

function StyleTab({ def, cfg, onChange }: { def: AnyIndicator; cfg: IndicatorConfig; onChange: (v: IndicatorConfig['styles']) => void }) {
  const styles = resolveStyles(def, cfg.styles);
  const set = (id: string, p: Partial<OutputStyle>) => onChange({ ...styles, [id]: { ...styles[id]!, ...p } });
  return (
    <div className="ind-styles">
      {Object.entries(def.outputs).map(([id, o]) => {
        const s = styles[id]!;
        return (
          <div key={id} className="ind-style-row">
            <Checkbox label="" checked={s.visible} onChange={(v) => set(id, { visible: v })} />
            <Input aria-label={`${o.label} label`} className="ind-style-label" value={s.label} onChange={(e) => set(id, { label: e.target.value })} />
            <ColorSwatch label={`${o.label} colour`} value={s.color} onChange={(c) => set(id, { color: c })} />
            {o.color2 && <ColorSwatch label={`${o.label} colour 2`} value={s.color2} onChange={(c) => set(id, { color2: c })} />}
            <NumberInput aria-label={`${o.label} width`} value={s.width} min={0.5} max={8} step={0.5} precision={1} onChange={(w) => set(id, { width: w })} />
            <Select
              small
              aria-label={`${o.label} line style`}
              value={s.style}
              onChange={(v) => set(id, { style: v as OutputStyle['style'] })}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
            />
            <span className="ind-opacity" title="Opacity">
              <Slider label={`${o.label} opacity`} value={Math.round(s.opacity * 100)} min={0} max={100} onChange={(v) => set(id, { opacity: v / 100 })} />
            </span>
            <Checkbox label="Tag" checked={s.priceTag} onChange={(v) => set(id, { priceTag: v })} />
          </div>
        );
      })}
    </div>
  );
}

function AdvancedTab({
  cfg,
  draft,
  update,
}: {
  cfg: IndicatorConfig;
  draft: IndicatorConfig[];
  update: (p: Partial<IndicatorConfig>) => void;
}) {
  const before = draft.slice(0, draft.findIndex((c) => c.uid === cfg.uid));
  const panes = before.filter((c) => c.pane === 'new');
  return (
    <div className="ind-form">
      <Row label="Pane" help="Price pane overlay, a new sub-pane, or share an existing pane.">
        <Select
          aria-label="Pane"
          value={cfg.pane}
          onChange={(v) => update({ pane: v })}
          options={[
            { value: 'overlay', label: 'Price pane (overlay)' },
            { value: 'new', label: 'New pane' },
            ...panes.map((p) => ({ value: p.uid, label: `Same pane as ${titleOf(indicatorById(p.type)!, p.inputs)}` })),
          ]}
        />
      </Row>
      <Row label="Scale" help="Merged: price scale (overlay) or the pane's shared scale. Own: independent scale.">
        <Select
          aria-label="Scale"
          value={cfg.scale}
          onChange={(v) => update({ scale: v as IndicatorConfig['scale'] })}
          options={[
            { value: 'merged', label: 'Merged' },
            { value: 'own', label: 'Own' },
          ]}
        />
      </Row>
      <Row label="Z-order" help="Draw above or below the price bars.">
        <Select
          aria-label="Z-order"
          value={cfg.z}
          onChange={(v) => update({ z: v as IndicatorConfig['z'] })}
          options={[
            { value: 'top', label: 'Above price' },
            { value: 'bottom', label: 'Below price' },
          ]}
        />
      </Row>
      <Row label="Pane height" help={`${PANE_HEIGHT.min}–${PANE_HEIGHT.max} px`}>
        <NumberInput aria-label="Pane height" value={cfg.height} min={PANE_HEIGHT.min} max={PANE_HEIGHT.max} step={10} unit="px" onChange={(h) => update({ height: h })} />
      </Row>
      <Row label="Data source" help="Overlaying another symbol is not available yet.">
        <Select aria-label="Data source" value="chart" onChange={() => {}} options={[{ value: 'chart', label: "This chart's instrument" }]} />
      </Row>
    </div>
  );
}
