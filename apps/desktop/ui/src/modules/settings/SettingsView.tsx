import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  BadgeDollarSign,
  Bell,
  CandlestickChart,
  Clock,
  Database,
  Download,
  Flame,
  Gauge,
  HelpCircle,
  Info,
  Keyboard,
  LayoutTemplate,
  Lock,
  Palette,
  Puzzle,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Table2,
  Timer,
  TrendingUp,
  Upload,
  Volume2,
  Rows3,
} from 'lucide-react';
import { Button, NumberInput, Toggle, Tooltip, toast } from '@htflow/ui-kit';
import {
  SCHEMA,
  SECTIONS,
  SETTING_KEYS,
  crossErrors,
  exportSettings,
  getDefaults,
  getSettings,
  importSettings,
  parseSettingsFile,
  resetAllSettings,
  sameValue,
  sectionKeys,
  setSettings,
  settingDef,
  useSettingsStore,
  validateSetting,
  type SectionId,
  type SettingDef,
  type SettingKey,
  type SettingsValues,
} from '../../state/settings';
import { useSession } from '../../state/session';
import { HOTKEY_PRESETS } from './model';
import { applyAppearance } from './effects';
import { clearLocalCaches } from './effects';
import { askConfirm } from '../../state/confirm';
import { clearLog, type LogLevel } from '../../state/log';
import {
  AboutPanel,
  LogPanel,
  ModuleFoldersEditor,
  TableLayoutsEditor,
  ModuleTogglesEditor,
  ProvidersEditor,
  DataSourcesEditor,
} from './panels';
import {
  ClocksEditor,
  CommissionRulesEditor,
  CustomSoundsEditor,
  HotkeysEditor,
  SoundEventsEditor,
  ThemePreview,
  TokensEditor,
} from './editors';

const ICONS: Record<SectionId, ReactNode> = {
  general: <Settings2 size={15} />,
  appearance: <Palette size={15} />,
  layout: <LayoutTemplate size={15} />,
  chart: <CandlestickChart size={15} />,
  footprint: <Table2 size={15} />,
  heatmap: <Flame size={15} />,
  dom: <Rows3 size={15} />,
  tape: <Activity size={15} />,
  trading: <TrendingUp size={15} />,
  data: <Database size={15} />,
  alerts: <Bell size={15} />,
  risk: <ShieldAlert size={15} />,
  privacy: <Lock size={15} />,
  logs: <ScrollText size={15} />,
  modules: <Puzzle size={15} />,
  about: <Info size={15} />,
  hotkeys: <Keyboard size={15} />,
  sounds: <Volume2 size={15} />,
  timezones: <Clock size={15} />,
  commission: <BadgeDollarSign size={15} />,
  dataDelays: <Timer size={15} />,
  performance: <Gauge size={15} />,
  common: <SlidersHorizontal size={15} />,
};

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      'timeZone',
    );
  } catch {
    return ['UTC', 'Europe/London', 'America/New_York', 'America/Chicago', 'Asia/Karachi'];
  }
})();

export function download(name: string, data: unknown): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickJson(onText: (t: string) => void) {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.json,application/json';
  i.onchange = () => void i.files?.[0]?.text().then(onText);
  i.click();
}

const fileStamp = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ simple controls

function Control({
  k,
  d,
  value,
  onChange,
}: {
  k: SettingKey;
  d: SettingDef;
  value: unknown;
  onChange(v: unknown): void;
}) {
  switch (d.type) {
    case 'number':
      return (
        <NumberInput
          aria-label={d.label}
          value={value as number}
          step={d.step}
          min={d.min}
          max={d.max}
          unit={d.unit}
          onChange={onChange}
        />
      );
    case 'boolean':
      return <Toggle label={d.label} checked={value as boolean} onChange={onChange} />;
    case 'enum':
      return (
        <select
          className="ht-select ht-select--sm"
          aria-label={d.label}
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
        >
          {d.options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'string':
      return (
        <input
          className="ht-input st-text"
          aria-label={d.label}
          value={value as string}
          placeholder={d.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'color':
      return <ColorControl label={d.label} value={value as string} onChange={onChange} />;
    case 'timezone':
      return (
        <select
          className="ht-select ht-select--sm"
          aria-label={d.label}
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
        >
          {d.special?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!ZONES.includes(value as string) && !d.special?.some((o) => o.value === value) && (
            <option value={value as string}>{value as string}</option>
          )}
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      );
    case 'custom':
      return <span className="muted">{k}</span>;
  }
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(v: unknown): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <span className="st-color">
      <input
        type="color"
        className="st-color-pick"
        aria-label={`${label} picker`}
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#808080'}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
      <input
        className="ht-input st-hex"
        aria-label={label}
        placeholder="Theme"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim());
        }}
      />
    </span>
  );
}

function Row({
  k,
  draft,
  defaults,
  error,
  onChange,
}: {
  k: SettingKey;
  draft: SettingsValues;
  defaults: SettingsValues;
  error?: string;
  onChange(k: SettingKey, v: unknown): void;
}) {
  const d = settingDef(k);
  const modified = !sameValue(draft[k], defaults[k]);
  return (
    <div className="st-row" data-testid={`setting-${k}`}>
      <span className="st-row-label">
        <span className="st-dot-slot">
          {modified && <span className="st-mod" title="Modified" />}
        </span>
        {d.label}
        <Tooltip
          content={
            <span className="st-tip">
              {d.help}
              {d.wired === false && <em> Stored; the module that uses it is not built yet.</em>}
            </span>
          }
        >
          <button type="button" className="st-help" aria-label={`Help: ${d.label}`}>
            <HelpCircle size={12} aria-hidden />
          </button>
        </Tooltip>
      </span>
      <span className="st-row-ctl">
        <Control k={k} d={d} value={draft[k]} onChange={(v) => onChange(k, v)} />
        {modified && (
          <button
            className="ht-icon-btn"
            aria-label={`Reset ${d.label}`}
            title="Reset to default"
            onClick={() => onChange(k, defaults[k])}
          >
            <RotateCcw size={12} />
          </button>
        )}
        {error && <span className="ht-error st-err">{error}</span>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ view

export function SettingsView({
  initialSection = 'general',
  onClose,
}: {
  initialSection?: SectionId;
  onClose?: () => void;
}) {
  const committed = useSettingsStore((s) => s.values);
  const defaults = useSettingsStore((s) => s.defaults);
  const [section, setSection] = useState<SectionId>(initialSection);
  const [query, setQuery] = useState('');
  const [hkFilter, setHkFilter] = useState('');
  const [draft, setDraft] = useState<SettingsValues>(committed);
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [preview, setPreview] = useState(true);
  const dirtyRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const session = useSession((s) => s.session);

  // P29 keyboard navigation: opening Settings (Ctrl+, / palette / menu) moves focus into it, on
  // the current section, so keyboard users land in the window they just opened.
  useEffect(() => {
    const nav = rootRef.current?.querySelector<HTMLElement>(
      '.st-nav-item[aria-current="page"], .st-nav-item',
    );
    nav?.focus({ preventScroll: true });
  }, []);

  // External changes (profile loaded, import) refresh the draft when there are no local edits.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(committed);
  }, [committed]);

  const dirty = SETTING_KEYS.some((k) => !sameValue(draft[k], committed[k]));
  dirtyRef.current = dirty;

  // Live preview of appearance; reverts to the committed look when the window closes.
  const appearanceKey = JSON.stringify([
    draft['appearance.theme'],
    draft['appearance.tokens'],
    draft['appearance.uiScale'],
    draft['appearance.fontSize'],
    draft['appearance.ribbonIconsOnly'],
  ]);
  useEffect(() => {
    if (preview) applyAppearance(draft);
    else applyAppearance(getSettings());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearanceKey, preview]);
  useEffect(() => () => applyAppearance(getSettings()), []);

  const change = (k: SettingKey, v: unknown) => {
    const r = validateSetting(k, v);
    setErrors((e) => {
      const n = { ...e };
      if (r.ok) delete n[k];
      else n[k] = r.error;
      return n;
    });
    setDraft((d) => ({ ...d, [k]: r.ok ? r.value : v }) as SettingsValues);
  };

  const allErrors = { ...errors, ...crossErrors(draft) };
  const hasErrors = Object.keys(allErrors).length > 0;

  const apply = () => {
    if (hasErrors) {
      toast('error', 'Fix the highlighted settings first');
      return false;
    }
    const patch: Partial<Record<SettingKey, unknown>> = {};
    for (const k of SETTING_KEYS) if (!sameValue(draft[k], committed[k])) patch[k] = draft[k];
    const e = setSettings(patch);
    setErrors(e);
    if (Object.keys(e).length) return false;
    dirtyRef.current = false;
    setDraft(getSettings());
    return true;
  };
  const cancel = () => {
    dirtyRef.current = false;
    setErrors({});
    setDraft(getSettings());
    applyAppearance(getSettings());
  };
  const resetPage = () => {
    for (const k of sectionKeys(section)) change(k, getDefaults()[k]);
  };

  const sectionModified = (s: SectionId) =>
    sectionKeys(s).some((k) => !sameValue(draft[k], defaults[k]));

  const q = query.trim().toLowerCase();
  const hits = useMemo(
    () =>
      q
        ? SETTING_KEYS.filter((k) => {
            const d = settingDef(k);
            const sec = SECTIONS.find((s) => s.id === d.section)!.label;
            return `${d.label} ${d.group} ${d.help} ${sec} ${d.keywords ?? ''} ${k}`
              .toLowerCase()
              .includes(q);
          })
        : [],
    [q],
  );

  const renderKeys = (keys: SettingKey[], withGroups = true) => {
    const groups = [...new Set(keys.map((k) => settingDef(k).group))];
    return groups.map((g) => (
      <section key={g} className="st-group">
        {withGroups && <div className="st-group-head">{g}</div>}
        {keys
          .filter((k) => settingDef(k).group === g)
          .map((k) => {
            const d = settingDef(k);
            if (d.type !== 'custom')
              return (
                <Row
                  key={k}
                  k={k}
                  draft={draft}
                  defaults={defaults}
                  error={allErrors[k]}
                  onChange={change}
                />
              );
            const props = {
              value: draft[k] as never,
              onChange: (v: unknown) => change(k, v),
              draft,
            };
            switch (d.editor) {
              case 'tokens':
                return <TokensEditor key={k} {...props} />;
              case 'hotkeys':
                return <HotkeysEditor key={k} {...props} filter={hkFilter} />;
              case 'soundEvents':
                return <SoundEventsEditor key={k} {...props} />;
              case 'customSounds':
                return <CustomSoundsEditor key={k} {...props} />;
              case 'commissionRules':
                return <CommissionRulesEditor key={k} {...props} />;
              case 'clocks':
                return <ClocksEditor key={k} {...props} />;
              case 'dataSources':
                return <DataSourcesEditor key={k} />;
              case 'providers':
                return <ProvidersEditor key={k} {...props} />;
              case 'moduleToggles':
                return <ModuleTogglesEditor key={k} {...props} />;
              case 'moduleFolders':
                return <ModuleFoldersEditor key={k} {...props} />;
              case 'tableLayouts':
                return <TableLayoutsEditor key={k} {...props} />;
            }
            return null;
          })}
      </section>
    ));
  };

  const meta = SECTIONS.find((s) => s.id === section)!;

  const pageButtons: ReactNode = (() => {
    switch (section) {
      case 'appearance':
        return (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => download(`htflow-theme-${fileStamp()}.json`, themeFile(draft))}
            >
              <Download size={13} /> Export theme
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                pickJson((t) => {
                  const r = parseThemeFile(t);
                  if (!r) return toast('error', 'Not an HT Flow theme file');
                  for (const [k, v] of Object.entries(r)) change(k as SettingKey, v);
                  toast('success', 'Theme loaded', 'Press Apply to keep it.');
                })
              }
            >
              <Upload size={13} /> Import theme
            </Button>
          </>
        );
      case 'hotkeys':
        return (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                download(`htflow-hotkeys-${fileStamp()}.json`, {
                  kind: 'htflow-hotkeys',
                  version: 1,
                  preset: draft['hotkeys.preset'],
                  bindings: draft['hotkeys.bindings'],
                })
              }
            >
              <Download size={13} /> Export hot keys
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                pickJson((t) => {
                  try {
                    const j = JSON.parse(t);
                    if (j?.kind !== 'htflow-hotkeys') throw new Error();
                    change('hotkeys.bindings', j.bindings);
                    if (j.preset) change('hotkeys.preset', j.preset);
                    toast('success', 'Hot keys loaded', 'Press Apply to keep them.');
                  } catch {
                    toast('error', 'Not an HT Flow hot keys file');
                  }
                })
              }
            >
              <Upload size={13} /> Import hot keys
            </Button>
          </>
        );
      case 'common':
        return (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                clearLocalCaches();
                toast('success', 'Cache cleared', 'Market data caches are rebuilt from the feeds.');
              }}
            >
              Clear cache
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                toast(
                  'info',
                  'Settings folder',
                  `%APPDATA%\\HTFlow\\profiles\\${session?.profileId ?? '<profile>'}\\settings.bin (encrypted). Opening Explorer needs the native shell command (not available yet).`,
                  8000,
                )
              }
            >
              Open settings folder
            </Button>
          </>
        );
      case 'privacy':
        return (
          <>
            <Button
              size="sm"
              variant="outline"
              data-testid="privacy-clear-cache"
              onClick={() => {
                clearLocalCaches();
                toast('success', 'Caches cleared', 'Session and market-data caches were deleted.');
              }}
            >
              Clear caches
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                clearLog();
                toast('success', 'Logs cleared', 'The in-memory log was emptied.');
              }}
            >
              Clear logs
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="privacy-reset-all"
              onClick={() =>
                void askConfirm({
                  title: 'Reset all settings',
                  body: 'Every setting on every page returns to its default. Your journal, alerts and layouts are not touched.',
                  confirmLabel: 'Reset everything',
                  danger: true,
                }).then((ok) => {
                  if (!ok) return;
                  resetAllSettings();
                  dirtyRef.current = false;
                  setDraft(getSettings());
                  toast('success', 'Settings reset', 'All settings are back to their defaults.');
                })
              }
            >
              Reset all settings…
            </Button>
          </>
        );
      case 'logs':
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toast(
                'info',
                'Log folder',
                `${draft['logs.folder']} — opening Explorer needs the native shell command (not available yet).`,
                8000,
              )
            }
          >
            Open log folder
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="st-root" data-testid="settings-window" ref={rootRef}>
      <nav className="st-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className="st-nav-item"
            aria-current={!q && s.id === section ? 'page' : undefined}
            onClick={() => {
              setSection(s.id);
              setQuery('');
            }}
          >
            {ICONS[s.id]}
            <span className="grow">{s.label}</span>
            {sectionModified(s.id) && <span className="st-mod" title="Has modified settings" />}
          </button>
        ))}
        <div className="grow" />
        <div className="st-nav-foot">
          <Button
            size="xs"
            variant="ghost"
            data-testid="settings-export"
            onClick={() =>
              download(`htflow-settings-${fileStamp()}.json`, exportSettings(getSettings()))
            }
          >
            <Download size={12} /> Export all settings
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              pickJson((t) => {
                const pre = parseSettingsFile(t);
                if (!pre.applied) return toast('error', 'Import failed', pre.errors[0]);
                const r = importSettings(t);
                dirtyRef.current = false;
                setDraft(getSettings());
                toast(
                  r.errors.length ? 'warning' : 'success',
                  `Imported ${r.applied} settings`,
                  r.errors.length
                    ? `${r.errors.length} skipped: ${r.errors.slice(0, 3).join('; ')}`
                    : undefined,
                );
              })
            }
          >
            <Upload size={12} /> Import settings…
          </Button>
        </div>
      </nav>
      <div className="st-main">
        <div className="st-head">
          <h2>{q ? 'Search results' : meta.label}</h2>
          {!q && (
            <Button
              size="xs"
              variant="ghost"
              onClick={resetPage}
              title="Reset every setting on this page to its default"
            >
              <RotateCcw size={12} /> Reset section
            </Button>
          )}
        </div>
        <input
          className="ht-input st-search"
          placeholder="Search all settings…"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!q && <p className="st-desc muted">{meta.description}</p>}
        <div className="st-body">
          {q ? (
            hits.length ? (
              SECTIONS.filter((s) => hits.some((k) => settingDef(k).section === s.id)).map((s) => (
                <div key={s.id}>
                  <button
                    className="st-hit-section"
                    onClick={() => (setSection(s.id), setQuery(''))}
                  >
                    {ICONS[s.id]} {s.label} ›
                  </button>
                  {renderKeys(
                    hits.filter(
                      (k) => settingDef(k).section === s.id && SCHEMA[k].type !== 'custom',
                    ),
                    false,
                  )}
                  {hits
                    .filter((k) => settingDef(k).section === s.id && SCHEMA[k].type === 'custom')
                    .map((k) => (
                      <div key={k} className="st-row">
                        <span className="st-row-label">{settingDef(k).label}</span>
                        <span className="st-row-ctl">
                          <Button size="xs" onClick={() => (setSection(s.id), setQuery(''))}>
                            Open
                          </Button>
                        </span>
                      </div>
                    ))}
                </div>
              ))
            ) : (
              <div className="tbl-empty">No settings match “{query}”</div>
            )
          ) : (
            <>
              {section === 'appearance' && (
                <div className="st-appearance-top">
                  <ThemePreview draft={draft} />
                  <label className="row gap8 center-y">
                    <Toggle label="Live preview" checked={preview} onChange={setPreview} /> Live
                    preview
                  </label>
                </div>
              )}
              {section === 'hotkeys' && (
                <div className="row gap8 center-y st-hk-tools">
                  <select
                    className="ht-select ht-select--sm"
                    aria-label="Hot key preset"
                    value={draft['hotkeys.preset']}
                    onChange={(e) => change('hotkeys.preset', e.target.value)}
                  >
                    {SCHEMA['hotkeys.preset'].options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="xs"
                    onClick={() =>
                      change(
                        'hotkeys.bindings',
                        HOTKEY_PRESETS[draft['hotkeys.preset'] as keyof typeof HOTKEY_PRESETS],
                      )
                    }
                  >
                    Apply preset
                  </Button>
                  <input
                    className="ht-input st-hk-filter"
                    placeholder="Filter commands…"
                    aria-label="Filter commands"
                    value={hkFilter}
                    onChange={(e) => setHkFilter(e.target.value)}
                  />
                </div>
              )}
              {renderKeys(sectionKeys(section).filter((k) => k !== 'hotkeys.preset'))}
              {section === 'about' && <AboutPanel />}
              {section === 'logs' && <LogPanel level={draft['logs.level'] as LogLevel} />}
            </>
          )}
        </div>
        <footer className="st-foot">
          {pageButtons}
          <div className="grow" />
          {dirty && <span className="muted st-unsaved">Unsaved changes</span>}
          <Button size="sm" variant="ghost" onClick={cancel} disabled={!dirty}>
            Cancel
          </Button>
          <Button size="sm" onClick={apply} disabled={!dirty}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              if (!dirty || apply()) onClose?.();
            }}
          >
            OK
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ theme file

function themeFile(v: SettingsValues) {
  return {
    kind: 'htflow-theme',
    version: 1,
    base: v['appearance.theme'],
    tokens: v['appearance.tokens'],
    uiScale: v['appearance.uiScale'],
    fontSize: v['appearance.fontSize'],
  };
}

export function parseThemeFile(text: string): Partial<Record<SettingKey, unknown>> | null {
  try {
    const j = JSON.parse(text);
    if (j?.kind !== 'htflow-theme') return null;
    const out: Partial<Record<SettingKey, unknown>> = {
      'appearance.theme': j.base,
      'appearance.tokens': j.tokens ?? {},
    };
    if (j.uiScale !== undefined) out['appearance.uiScale'] = j.uiScale;
    if (j.fontSize !== undefined) out['appearance.fontSize'] = j.fontSize;
    for (const [k, v] of Object.entries(out))
      if (!validateSetting(k as SettingKey, v).ok) return null;
    return out;
  } catch {
    return null;
  }
}
