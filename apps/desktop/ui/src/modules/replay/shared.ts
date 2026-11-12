import { useEffect, useState } from 'react';
import { DEFAULT_LAYERS, type ReplayEngine } from '@htflow/replay';
import {
  DEFAULT_DISPLAY,
  normalizeBookmarks,
  normalizeDisplay,
  normalizeLoop,
  sameSavedState,
  savedStateOf,
  type ReplayDisplay,
  type SavedReplayState,
} from './logic';
import { backend } from '../../backend';
import {
  onReplaySession,
  replayEngine,
  replaySession,
  type ReplayConfig,
  type ReplaySession,
} from '../../feeds/replay';

/** Saved one-click practice sessions (P24 "Add replay template"). */
export interface ReplayTemplate {
  id: string;
  name: string;
  config: ReplayConfig;
  /** Bookmarks and loop range, saved per template (P24). */
  bookmarks?: SavedReplayState['bookmarks'];
  loop?: SavedReplayState['loop'];
}

const KEY = 'replay.templates';
let templates: ReplayTemplate[] = [];
let loaded: Promise<void> | null = null;
const tplListeners = new Set<() => void>();

function valid(t: unknown): t is ReplayTemplate {
  const x = t as ReplayTemplate;
  return (
    !!x &&
    typeof x.name === 'string' &&
    Array.isArray(x.config?.instruments) &&
    x.config.instruments.length > 0 &&
    Number.isFinite(x.config.from) &&
    Number.isFinite(x.config.to) &&
    x.config.to > x.config.from
  );
}

export function loadTemplates(): Promise<void> {
  loaded ??= backend
    .loadSettings<ReplayTemplate[]>(KEY)
    .then((list) => {
      templates = (list ?? []).filter(valid).map((t) => ({
        ...t,
        config: {
          ...t.config,
          layers: {
            ...DEFAULT_LAYERS,
            ...t.config.layers,
            hideFuture: t.config.layers?.hideFuture !== false,
          },
        },
        bookmarks: normalizeBookmarks(t.bookmarks, t.config.from, t.config.to),
        loop: normalizeLoop(t.loop, t.config.from, t.config.to),
      }));
      tplListeners.forEach((l) => l());
    })
    .catch(() => {});
  return loaded;
}

export function replayTemplates(): ReplayTemplate[] {
  return templates;
}

export function saveTemplates(next: ReplayTemplate[]): void {
  templates = next;
  tplListeners.forEach((l) => l());
  void backend.saveSettings(KEY, next).catch(() => {});
}

export function addTemplate(name: string, config: ReplayConfig, state?: SavedReplayState): void {
  saveTemplates([
    ...templates,
    {
      id: `rt${Date.now().toString(36)}`,
      name,
      config: { ...config, templateId: undefined },
      bookmarks: state?.bookmarks ?? [],
      loop: state?.loop ?? null,
    },
  ]);
}

/** Puts a template's saved bookmarks and loop range on a freshly started session. */
export function applyTemplateState(s: ReplaySession, t: ReplayTemplate): void {
  for (const e of s.engines.values()) {
    const marks = normalizeBookmarks(t.bookmarks, e.start, e.end);
    e.setBookmarks(marks.map((b, i) => ({ id: `tpl${i}`, t: b.t, label: b.label })));
    e.setLoop(normalizeLoop(t.loop, e.start, e.end));
  }
}

// Bookmarks and the loop range of a session started from a template are saved back to it.
const bound = new WeakSet<ReplaySession>();
function bindTemplateSession(): void {
  const s = replaySession();
  const id = s?.config.templateId;
  if (!s || !id || bound.has(s)) return;
  bound.add(s);
  const e = s.group.primary;
  e.onChange(() => {
    if (replaySession() !== s) return;
    const i = templates.findIndex((t) => t.id === id);
    if (i < 0) return;
    const cur = savedStateOf(e.bookmarks, e.loop);
    const prev = savedStateOf(templates[i]!.bookmarks ?? [], templates[i]!.loop ?? null);
    if (sameSavedState(cur, prev)) return;
    saveTemplates(
      templates.map((t, k) => (k === i ? { ...t, bookmarks: cur.bookmarks, loop: cur.loop } : t)),
    );
  });
}
onReplaySession(bindTemplateSession);

// ------------------------------------------------------------------ display options

const DISPLAY_KEY = 'replay.display';
let display: ReplayDisplay = DEFAULT_DISPLAY;
let displayLoaded = false;
const displayListeners = new Set<() => void>();

export function replayDisplay(): ReplayDisplay {
  if (!displayLoaded) {
    displayLoaded = true;
    backend
      .loadSettings<unknown>(DISPLAY_KEY)
      .then((raw) => {
        display = normalizeDisplay(raw);
        displayListeners.forEach((l) => l());
      })
      .catch(() => {});
  }
  return display;
}

export function setReplayDisplay(patch: Partial<ReplayDisplay>): void {
  display = normalizeDisplay({ ...display, ...patch });
  displayListeners.forEach((l) => l());
  void backend.saveSettings(DISPLAY_KEY, display).catch(() => {});
}

export function onReplayDisplay(fn: () => void): () => void {
  displayListeners.add(fn);
  return () => void displayListeners.delete(fn);
}

export function useReplayDisplay(): ReplayDisplay {
  const [, set] = useState(0);
  useEffect(() => onReplayDisplay(() => set((x) => x + 1)), []);
  return replayDisplay();
}

export function useTemplates(): ReplayTemplate[] {
  const [, set] = useState(0);
  useEffect(() => {
    void loadTemplates();
    const l = () => set((x) => x + 1);
    tplListeners.add(l);
    return () => void tplListeners.delete(l);
  }, []);
  return templates;
}

/** Re-renders (≤ hz per second) while the session or the engine changes. */
export function useReplayEngine(instrumentId: string, hz = 10): ReplayEngine | undefined {
  const [, set] = useState(0);
  const e = replayEngine(instrumentId);
  useEffect(() => {
    let pending = false;
    const bump = () => (pending = true);
    const un1 = onReplaySession(() => set((x) => x + 1));
    const un2 = e?.onChange(bump);
    const i = setInterval(() => {
      if (pending) {
        pending = false;
        set((x) => x + 1);
      }
    }, 1000 / hz);
    return () => {
      un1();
      un2?.();
      clearInterval(i);
    };
  }, [e, hz]);
  return e;
}

export function useReplaySession() {
  const [, set] = useState(0);
  useEffect(() => {
    const un = onReplaySession(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), 250);
    return () => {
      un();
      clearInterval(i);
    };
  }, []);
  return replaySession();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** epoch ms → value for <input type="datetime-local"> (local time). */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): number {
  return new Date(s).getTime();
}

export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtHm(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRange(from: number, to: number): string {
  const d = new Date(from);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} · ${fmtHm(from)}–${fmtHm(to)}`;
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
