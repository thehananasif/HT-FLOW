/**
 * Chart settings window (P34, board 10): Visual Settings | Footprint settings | Trading Settings |
 * Templates. Search across rows, collapsible sections, 2-column property grid, help panel.
 * Every change previews live on the chart (stored in the window state); Cancel reverts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { Button, Input, Tabs, toast } from '@htflow/ui-kit';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { instrumentById } from '../../state/instruments';
import {
  diffFromDefaults,
  matchesQuery,
  normalizeSettings,
  resetTab,
  TABS,
  type RowDef,
  type TabId,
} from '../../charts/settings/schema';
import {
  baseSettings,
  chartSettings,
  extState,
  SETTINGS_EXT,
  setChartSettings,
  type ChartExtState,
} from '../../charts/settings/state';
import { useChartSettingsUi } from '../../charts/settingsUi';
import { chartAction } from '../../charts/bus';
import { downloadText, pickTextFile } from '../../charts/templateStore';
import { RowEditor } from './editors';
import { TemplatesTab } from './TemplatesTab';

import { translateLiteral as tl } from '@htflow/i18n';
const ALL_TABS: { value: TabId; label: string }[] = [
  ...TABS.map((t) => ({ value: t.id, label: t.label })),
  { value: 'templates', label: 'Templates' },
];

export function ChartSettingsWindow({ windowId }: { windowId: string }) {
  const s = useWindows((st) => st.windows[windowId]) as ChartWindowState | undefined;
  const { tab, close } = useChartSettingsUi();
  const setTab = (t: TabId) => useChartSettingsUi.setState({ tab: t });
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<RowDef | null>(null);
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round(window.innerWidth / 2 - 380)),
    y: Math.max(16, Math.round(window.innerHeight / 2 - 330)),
  }));
  // Snapshot for Cancel (revert every live change).
  const snapshot = useRef<{ ext: ChartExtState; footprintMode: string } | null>(null);
  if (!snapshot.current && s)
    snapshot.current = { ext: structuredClone(extState(s)), footprintMode: s.footprintMode };

  const settings = useMemo(() => chartSettings(s), [s]);
  const cancelRef = useRef<() => void>(() => close());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc inside the window cancels; Esc in a nested popover / dialog only closes that.
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !e.defaultPrevented && t?.closest?.('.cs-window'))
        cancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!s || s.kind !== 'chart') return null;
  const inst = instrumentById(s.instrumentId);

  const setValue = (row: RowDef, v: unknown) => {
    if (row.bind === 'footprintMode') {
      useWindows.getState().patch(windowId, {
        footprintMode: String(v),
        template: s.template === 'candles-vp' ? 'footprint' : s.template,
      } as Partial<WindowState>);
      return;
    }
    setChartSettings(windowId, {
      ...chartSettings(useWindows.getState().windows[windowId] as ChartWindowState),
      [row.key]: v,
    });
  };
  const valueOf = (row: RowDef) =>
    row.bind === 'footprintMode' ? s.footprintMode : settings[row.key];

  const cancel = () => {
    cancelImpl();
  };
  function cancelImpl() {
    const snap = snapshot.current;
    const cur = useWindows.getState().windows[windowId];
    if (snap && cur?.kind === 'chart')
      useWindows.getState().patch(windowId, {
        footprintMode: snap.footprintMode,
        ext: { ...(cur.ext ?? {}), [SETTINGS_EXT]: snap.ext },
      } as Partial<WindowState>);
    close();
  }

  cancelRef.current = cancel;

  const exportJson = () => {
    const base = baseSettings();
    downloadText(
      `${inst?.symbol ?? 'chart'}-settings.json`,
      JSON.stringify(
        {
          kind: 'htflow.chart-settings',
          version: 1,
          footprintMode: s.footprintMode,
          settings: diffFromDefaults(settings, base),
        },
        null,
        2,
      ),
    );
  };
  const importJson = async () => {
    const text = await pickTextFile('.json,application/json');
    if (!text) return;
    try {
      const raw = JSON.parse(text) as { kind?: string; settings?: unknown };
      if (raw.kind !== 'htflow.chart-settings') throw new Error('kind');
      setChartSettings(windowId, normalizeSettings(raw.settings, baseSettings()));
      toast('success', tl('Chart settings imported'));
    } catch {
      toast('error', tl('Not a chart settings file'));
    }
  };

  const tabDef = TABS.find((t) => t.id === tab);
  const q = query.trim();
  // Search spans every tab; without a query only the current tab is shown.
  const sections = (q ? TABS : tabDef ? [tabDef] : []).flatMap((t) =>
    t.sections
      .map((sec) => ({
        tab: t,
        sec,
        rows: sec.rows.filter((r) => matchesQuery(r, sec, q)),
      }))
      .filter((x) => x.rows.length),
  );

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const ox = e.clientX - pos.x;
    const oy = e.clientY - pos.y;
    const move = (ev: MouseEvent) =>
      setPos({
        x: Math.min(window.innerWidth - 120, Math.max(0, ev.clientX - ox)),
        y: Math.min(window.innerHeight - 60, Math.max(0, ev.clientY - oy)),
      });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const help =
    sel?.help ??
    (sel
      ? `${sel.label}.`
      : 'Click any row to see what it does. Every value is saved per chart and can be saved into a template.');

  return createPortal(
    <div
      className="cs-window"
      role="dialog"
      aria-label={tl('Chart settings')}
      data-testid="chart-settings"
      style={{ left: pos.x, top: pos.y }}
    >
      <header className="cs-head" onMouseDown={startDrag}>
        <span className="cs-title">
          {tl('Chart settings ·')} {inst?.symbol ?? s.instrumentId} {tl('· template:')}{' '}
          {s.template.replace(/-/g, ' ')}
        </span>
        <div className="grow" />
        <button className="ht-icon-btn" aria-label={tl('Close chart settings')} onClick={cancel}>
          <X size={14} />
        </button>
      </header>
      <div className="cs-tabs">
        <Tabs tabs={ALL_TABS} value={tab} onChange={setTab} />
        {tab !== 'templates' && (
          <>
            <div className="grow" />
            <span className="cs-search">
              <Search size={12} />
              <Input
                aria-label={tl('Search chart settings')}
                placeholder={tl('Search settings')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <button className="ht-chip ht-chip--ghost" onClick={() => setClosed({})}>
              {tl('Expand all')}
            </button>
            <button
              className="ht-chip ht-chip--ghost"
              onClick={() =>
                setClosed(
                  Object.fromEntries(sections.map((x) => [`${x.tab.id}/${x.sec.id}`, true])),
                )
              }
            >
              {tl('Collapse all')}
            </button>
          </>
        )}
      </div>
      <div className="cs-body">
        {tab === 'templates' ? (
          <TemplatesTab windowId={windowId} state={s} />
        ) : (
          <>
            {!sections.length && (
              <p className="muted cs-empty">
                {tl('No settings match “')}
                {q}”.
              </p>
            )}
            {sections.map(({ tab: t, sec, rows }) => {
              const key = `${t.id}/${sec.id}`;
              const open = q ? true : !closed[key];
              return (
                <section key={key} className="cs-section">
                  <button
                    className="cs-sec-head"
                    aria-expanded={open}
                    onClick={() => setClosed((c) => ({ ...c, [key]: open }))}
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>{q ? `${t.label} › ${sec.label}` : sec.label}</span>
                    <span className="cs-count">
                      {rows.length} {tl('settings')}
                    </span>
                  </button>
                  {open && (
                    <div className="cs-grid">
                      {rows.map((r) => (
                        <div
                          key={r.key}
                          className={`cs-row${sel?.key === r.key ? ' cs-row--sel' : ''}${r.indent ? ' cs-row--indent' : ''}`}
                          data-key={r.key}
                          onMouseDown={() => setSel(r)}
                          onFocus={() => setSel(r)}
                        >
                          <span className="cs-name" title={r.help}>
                            {r.label}
                          </span>
                          <span className="cs-editor">
                            <RowEditor
                              row={r}
                              value={valueOf(r)}
                              onChange={(v) => setValue(r, v)}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
      {tab !== 'templates' && (
        <div className="cs-help" aria-live="polite">
          <strong>{sel?.label ?? 'Help'}</strong>
          <span>{help}</span>
          {sel?.consumer && (
            <span className="muted">
              {' '}
              {tl('Used by')} {sel.consumer} {tl('on this chart.')}
            </span>
          )}
        </div>
      )}
      <footer className="cs-foot">
        {tab !== 'templates' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChartSettings(windowId, resetTab(settings, tab))}
          >
            {tl('Reset tab to default')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={exportJson}>
          {tl('Export JSON')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void importJson()}>
          {tl('Import JSON')}
        </Button>
        <div className="grow" />
        <Button variant="secondary" size="sm" onClick={cancel}>
          {tl('Cancel')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => chartAction('save-template', windowId)}>
          {tl('Save Template')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            snapshot.current = null;
            close();
          }}
        >
          {tl('OK')}
        </Button>
      </footer>
    </div>,
    document.body,
  );
}
