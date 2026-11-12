import { useSyncExternalStore } from 'react';
import {
  BUILTIN_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  builtinTemplate,
  sanitizeTemplate,
  type DomTemplate,
} from '@htflow/dom';
import { backend } from '../../backend';
import { useSession } from '../../state/session';

/**
 * Smart DOM per-user data: edited built-ins + custom templates, and price notes per instrument.
 * Persisted through backend.saveSettings (encrypted per profile).
 */

const TEMPLATES_KEY = 'smart-dom.templates';
const NOTES_KEY = 'smart-dom.notes';

interface SavedTemplates {
  /** Edited built-ins and custom templates, by id. */
  templates: DomTemplate[];
  /** Custom template order (ids). */
  order: string[];
}

let saved: SavedTemplates = { templates: [], order: [] };
let notes: Record<string, Record<string, string>> = {};
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

let saveT: ReturnType<typeof setTimeout> | null = null;
function persistTemplates(): void {
  if (saveT) clearTimeout(saveT);
  saveT = setTimeout(() => void backend.saveSettings(TEMPLATES_KEY, saved).catch(() => {}), 300);
}
let noteT: ReturnType<typeof setTimeout> | null = null;
function persistNotes(): void {
  if (noteT) clearTimeout(noteT);
  noteT = setTimeout(() => void backend.saveSettings(NOTES_KEY, notes).catch(() => {}), 300);
}

export const domStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: () => version,

  /** Built-ins (with the user's edits) in menu order, then custom templates. */
  templates(): DomTemplate[] {
    const byId = new Map(saved.templates.map((t) => [t.id, t]));
    const builtins = BUILTIN_TEMPLATES.map((b) => byId.get(b.id) ?? b);
    const custom = saved.order.map((id) => byId.get(id)).filter((t): t is DomTemplate => !!t);
    return [...builtins, ...custom];
  },

  get(id: string | undefined): DomTemplate {
    const t = this.templates();
    return t.find((x) => x.id === id) ?? t.find((x) => x.id === DEFAULT_TEMPLATE_ID)!;
  },

  isEdited(id: string): boolean {
    return !!builtinTemplate(id) && saved.templates.some((t) => t.id === id);
  },

  save(t: DomTemplate): void {
    const clean = { ...sanitizeTemplate(t, t.id), id: t.id, builtin: !!builtinTemplate(t.id) };
    const rest = saved.templates.filter((x) => x.id !== t.id);
    const order =
      clean.builtin || saved.order.includes(t.id) ? saved.order : [...saved.order, t.id];
    saved = { templates: [...rest, clean], order };
    persistTemplates();
    changed();
  },

  /** Deletes a custom template, or resets an edited built-in to its default. */
  remove(id: string): void {
    saved = {
      templates: saved.templates.filter((x) => x.id !== id),
      order: saved.order.filter((x) => x !== id),
    };
    persistTemplates();
    changed();
  },

  newId(): string {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  },

  notes(instrumentId: string): ReadonlyMap<number, string> {
    return noteMaps.get(instrumentId) ?? EMPTY;
  },

  setNote(instrumentId: string, px: number, text: string): void {
    const cur = { ...(notes[instrumentId] ?? {}) };
    const v = text.trim().slice(0, 200);
    if (v) cur[String(px)] = v;
    else delete cur[String(px)];
    notes = { ...notes, [instrumentId]: cur };
    rebuildNoteMap(instrumentId);
    persistNotes();
    changed();
  },

  clearNotes(instrumentId: string): void {
    notes = { ...notes, [instrumentId]: {} };
    rebuildNoteMap(instrumentId);
    persistNotes();
    changed();
  },
};

const EMPTY: ReadonlyMap<number, string> = new Map();
const noteMaps = new Map<string, Map<number, string>>();
function rebuildNoteMap(instrumentId: string): void {
  const m = new Map<number, string>();
  for (const [k, v] of Object.entries(notes[instrumentId] ?? {})) {
    const px = Number(k);
    if (Number.isFinite(px) && typeof v === 'string' && v) m.set(px, v);
  }
  noteMaps.set(instrumentId, m);
}

/** Re-renders when templates or notes change. */
export function useDomStore(): number {
  return useSyncExternalStore(domStore.subscribe, domStore.version);
}

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  saved = { templates: [], order: [] };
  notes = {};
  noteMaps.clear();
  changed();
  if (!id) return;
  void backend
    .loadSettings<SavedTemplates>(TEMPLATES_KEY)
    .then((s) => {
      if (!s || !Array.isArray(s.templates)) return;
      const templates = s.templates.map((t) => {
        const id0 = typeof t?.id === 'string' ? t.id : domStore.newId();
        return { ...sanitizeTemplate(t, id0), id: id0, builtin: !!builtinTemplate(id0) };
      });
      const order = (Array.isArray(s.order) ? s.order : []).filter(
        (x): x is string => typeof x === 'string' && templates.some((t) => t.id === x),
      );
      for (const t of templates) if (!t.builtin && !order.includes(t.id)) order.push(t.id);
      saved = { templates, order };
      changed();
    })
    .catch(() => {});
  void backend
    .loadSettings<Record<string, Record<string, string>>>(NOTES_KEY)
    .then((n) => {
      if (!n || typeof n !== 'object') return;
      notes = n;
      for (const k of Object.keys(n)) rebuildNoteMap(k);
      changed();
    })
    .catch(() => {});
}
useSession.subscribe(onSession);
onSession();
