import { ATM_PRESETS, blankAtm, normalizeAtm, type AtmTemplate } from '@htflow/trading';
import { Persisted, usePersisted } from './persist';

/** User ATM templates (built-in presets are not stored; they are always listed first). */
export const atmStore = new Persisted<AtmTemplate[]>(
  'atm.templates',
  () => [],
  (raw) =>
    Array.isArray(raw)
      ? raw.map(normalizeAtm).filter((t): t is AtmTemplate => !!t && !t.builtin)
      : [],
);

export function allTemplates(user = atmStore.get()): AtmTemplate[] {
  return [...ATM_PRESETS, ...user];
}

export function useAtmTemplates(): AtmTemplate[] {
  const user = usePersisted(atmStore);
  return allTemplates(user);
}

export function templateById(id: string): AtmTemplate | undefined {
  return id ? allTemplates().find((t) => t.id === id) : undefined;
}

let seq = 0;
const newId = () => `atm-${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Adds a template (a copy of `from` or a blank one) and returns it. */
export function addTemplate(from?: AtmTemplate): AtmTemplate {
  const base = from ? structuredClone(from) : blankAtm('');
  const names = new Set(allTemplates().map((t) => t.name));
  let name = from ? `${from.name} copy` : 'New template';
  for (let i = 2; names.has(name); i++)
    name = `${from ? from.name + ' copy' : 'New template'} ${i}`;
  const t: AtmTemplate = { ...base, id: newId(), name, builtin: undefined };
  atmStore.update((l) => [...l, t]);
  return t;
}

export function saveTemplate(t: AtmTemplate): void {
  if (t.builtin) return;
  atmStore.update((l) => l.map((x) => (x.id === t.id ? t : x)));
}

export function deleteTemplate(id: string): void {
  atmStore.update((l) => l.filter((x) => x.id !== id));
}

/** Export / import as JSON (share templates between profiles). */
export function exportTemplates(): string {
  return JSON.stringify(atmStore.get(), null, 2);
}

export function importTemplates(json: string): number {
  const raw: unknown = JSON.parse(json);
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(normalizeAtm)
    .filter((t): t is AtmTemplate => !!t)
    .map((t) => ({ ...t, id: newId(), builtin: undefined }));
  atmStore.update((l) => [...l, ...list]);
  return list.length;
}
