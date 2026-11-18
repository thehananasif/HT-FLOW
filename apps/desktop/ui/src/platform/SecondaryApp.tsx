import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview';
import { Minus, PanelTopClose, Square, X } from 'lucide-react';
import { Button, EmptyState, LogoBars } from '@htflow/ui-kit';
import { windowTitle, type PanelSpec, type WindowState } from '@htflow/workspace';
import { backend } from '../backend';
import { useWindows } from '../state/windows';
import { instrumentById } from '../state/instruments';
import { ChartWindow } from '../charts/ChartWindow';
import { DomWindow } from '../trading/DomView';
import { ModuleWindow } from '../dashboard/ModuleWindow';
import { WindowHeader } from '../dashboard/WindowHeader';
import { CommandPalette } from '../shell/CommandPalette';
import { installHotkeys, registerCommands } from '../shell/commands';
import { requestReattach, sendLayout, startSecondary, useSecondary } from './secondary';

import { translateLiteral as tl } from '@htflow/i18n';
const theme: DockviewTheme = { name: 'htflow', className: 'dockview-theme-htflow', gap: 4 };
const components = { chart: ChartWindow, dom: DomWindow, module: ModuleWindow };

const titleOf = (s: WindowState) =>
  windowTitle(s, s.kind !== 'module' ? (instrumentById(s.instrumentId)?.symbol ?? '') : '');

/** Builds the dock of an OS window from its saved layout, specs, or one tab per window. */
function build(api: DockviewApi, ids: string[], layout: unknown): void {
  const windows = useWindows.getState().windows;
  api.clear();
  const l = layout as { specs?: PanelSpec[]; panels?: unknown } | null | undefined;
  if (l && l.panels) {
    try {
      api.fromJSON(l as Parameters<DockviewApi['fromJSON']>[0]);
      return;
    } catch (e) {
      console.warn('OS window layout restore failed', e);
      api.clear();
    }
  }
  if (l?.specs?.length) {
    for (const s of l.specs) {
      const st = windows[s.id];
      if (!st) continue;
      const ref = s.position && api.getPanel(s.position.ref);
      api.addPanel({
        id: s.id,
        component: st.kind,
        title: titleOf(st),
        position: ref ? { referencePanel: ref, direction: s.position!.dir } : undefined,
      });
    }
    return;
  }
  let first: string | null = null;
  for (const id of ids) {
    const st = windows[id];
    if (!st) continue;
    const ref = first ? api.getPanel(first) : undefined;
    api.addPanel({
      id,
      component: st.kind,
      title: titleOf(st),
      position: ref ? { referencePanel: ref, direction: 'within' } : undefined,
    });
    first ??= id;
  }
}

/**
 * A secondary OS window (`?window=<label>`): only its dock group / workspace with a compact title
 * bar — no ribbon, layout tabs or status bar. Re-attach (or closing it) puts the windows back.
 */
export function SecondaryApp({ label }: { label: string }) {
  const st = useSecondary();
  const apiRef = useRef<DockviewApi | null>(null);
  const loading = useRef(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const windows = useWindows((s) => s.windows);

  useEffect(() => startSecondary(label), [label]);

  useEffect(() => {
    const un = registerCommands([
      {
        id: 'palette',
        label: 'Command palette',
        group: 'Platform',
        shortcut: 'Ctrl+K',
        run: () => setPaletteOpen((x) => !x),
      },
      {
        id: 'window.reattach-this',
        label: 'Window: Re-attach this window to the main window',
        group: 'Layout',
        keywords: 'os window monitor dock back',
        run: requestReattach,
      },
    ]);
    const unk = installHotkeys();
    return () => {
      un();
      unk();
    };
  }, []);

  const rebuild = useCallback(() => {
    const api = apiRef.current;
    const s = useSecondary.getState();
    if (!api || s.phase !== 'ready' || !s.entry) return;
    loading.current = true;
    try {
      build(api, s.entry.ids, s.entry.layout);
    } finally {
      loading.current = false;
    }
  }, []);

  // (Re)build whenever the main window sends an init.
  useEffect(() => {
    if (st.phase === 'ready') rebuild();
  }, [st.entry, st.phase, rebuild]);

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      e.api.onDidRemovePanel((p) => {
        if (!loading.current) useWindows.getState().remove(p.id);
      });
      e.api.onDidActivePanelChange((p) => p && useWindows.getState().setActive(p.id));
      let timer: ReturnType<typeof setTimeout> | null = null;
      e.api.onDidLayoutChange(() => {
        if (loading.current) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => sendLayout(e.api.toJSON()), 600);
      });
      rebuild();
    },
    [rebuild],
  );

  // Tab titles follow the window states; the OS window closes when its last window is gone.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const [id, s] of Object.entries(windows)) api.getPanel(id)?.api.setTitle(titleOf(s));
  }, [windows]);

  const title = st.entry?.title ?? 'HT Flow';
  useEffect(() => {
    document.title = `${title} — HT Flow`;
  }, [title]);

  return (
    <div className="app-root os-window" data-testid="os-window" data-label={label}>
      <header className="titlebar os-window-bar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <LogoBars size={14} />
          <span data-testid="os-window-title">{title}</span>
        </div>
        <div className="titlebar-spacer" data-tauri-drag-region />
        <Button
          size="xs"
          variant="ghost"
          onClick={requestReattach}
          data-testid="os-window-reattach"
          title={tl('Put these windows back into the main window')}
        >
          <PanelTopClose size={13} /> {tl('Re-attach')}
        </Button>
        <div className="win-controls">
          <button aria-label={tl('Minimize')} onClick={() => backend.window.minimize()}>
            <Minus size={15} />
          </button>
          <button aria-label={tl('Maximize')} onClick={() => backend.window.toggleMaximize()}>
            <Square size={12} />
          </button>
          <button aria-label={tl('Close')} className="win-close" onClick={requestReattach}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="workspace-row">
        <div className="dock-host" data-testid="os-window-dock">
          {st.phase === 'ready' ? (
            <DockviewReact
              components={components}
              defaultTabComponent={WindowHeader}
              onReady={onReady}
              theme={theme}
              singleTabMode="fullwidth"
            />
          ) : (
            <EmptyState
              icon={<LogoBars size={28} />}
              title={st.phase === 'closing' ? 'Closing…' : 'Waiting for the main window…'}
            >
              {tl(
                'This window shows windows detached from the main HT Flow window. It connects when the main window is open; in a browser, detached windows float inside the main window.',
              )}
            </EmptyState>
          )}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
