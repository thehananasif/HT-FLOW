import { create } from 'zustand';
import { toast } from '@htflow/ui-kit';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { backend } from '../backend';
import { useWindows } from '../state/windows';
import {
  addTemplate,
  allTemplates,
  applyTemplate,
  EMPTY_LIBRARY,
  makeTemplate,
  parseLibrary,
  type TemplateLibrary,
  type UserChartTemplate,
} from './templates';

import { translateLiteral as tl, tt } from '@htflow/i18n';
const KEY = 'chart-templates';

interface TemplateStoreState {
  lib: TemplateLibrary;
  loaded: boolean;
  load(): Promise<void>;
  /** Applies a library transform and persists it. */
  update(fn: (l: TemplateLibrary) => TemplateLibrary): void;
}

/** User chart templates, saved per profile (encrypted settings). */
export const useChartTemplates = create<TemplateStoreState>((set, get) => ({
  lib: EMPTY_LIBRARY,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await backend.loadSettings<unknown>(KEY);
      set({ lib: parseLibrary(raw), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: (fn) => {
    const lib = fn(get().lib);
    set({ lib });
    void backend
      .saveSettings(KEY, lib)
      .catch(() => toast('error', tl('Could not save chart templates')));
  },
}));

export function templateById(id: string): UserChartTemplate | undefined {
  return allTemplates(useChartTemplates.getState().lib).find((t) => t.id === id);
}

function chartWindow(id: string): ChartWindowState | undefined {
  const w = useWindows.getState().windows[id];
  return w?.kind === 'chart' ? w : undefined;
}

/** Applies a template (user or style preset) to a chart window. */
export function applyTemplateTo(windowId: string, id: string): void {
  const s = chartWindow(windowId);
  const t = templateById(id);
  if (!s || !t) return;
  useWindows.getState().patch(windowId, applyTemplate(s, t) as Partial<WindowState>);
}

/** Saves the chart's current state as a new template; returns it. */
export function saveTemplateFrom(windowId: string, name: string): UserChartTemplate | null {
  const s = chartWindow(windowId);
  if (!s) return null;
  const t = makeTemplate(name, s);
  let saved: UserChartTemplate = t;
  useChartTemplates.getState().update((l) => {
    const next = addTemplate(l, t);
    saved = next.templates[next.templates.length - 1]!;
    return next;
  });
  toast('success', tt`Template “${saved.name}” saved`);
  return saved;
}

/** Downloads text as a file (export JSON / CSV). */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Opens a file picker and resolves with the file text (or null). */
export function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > 2_000_000) {
        toast('error', tl('File too large'));
        return resolve(null);
      }
      void f.text().then(resolve);
    };
    input.click();
  });
}
