import {
  BLANK_SCRIPT,
  normalizeProject,
  templateById,
  type StrategyProject,
} from '@htflow/strategy';
import { Persisted, usePersisted } from '../../../trading/persist';

/** HT Editor strategies saved per profile (settings key `strategies.scripts`). */
export const scriptStore = new Persisted<StrategyProject[]>(
  'strategies.scripts',
  () => [],
  (raw) => {
    if (!Array.isArray(raw)) return [];
    const out: StrategyProject[] = [];
    for (const p of raw.slice(0, 200)) {
      try {
        out.push(normalizeProject(p));
      } catch {
        /* drop corrupt entries */
      }
    }
    return out;
  },
);

export const useScripts = () => usePersisted(scriptStore);

let counter = 0;
export function newProjectId(now = Date.now()): string {
  return `stg-${now.toString(36)}-${(++counter).toString(36)}`;
}

export function newProject(templateId?: string, now = Date.now()): StrategyProject {
  const t = templateId ? templateById(templateId) : undefined;
  return {
    id: newProjectId(now),
    name: t?.name ?? 'My strategy',
    files: [{ name: 'strategy.ts', source: t?.source ?? BLANK_SCRIPT }],
    params: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function saveProject(p: StrategyProject): void {
  const next = { ...p, updatedAt: Date.now() };
  scriptStore.update((all) =>
    all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? next : x)) : [...all, next],
  );
}

export function deleteProject(id: string): void {
  scriptStore.update((all) => all.filter((x) => x.id !== id));
}

export function projectById(id: string): StrategyProject | undefined {
  return scriptStore.get().find((p) => p.id === id);
}

/** Set before switching to the VPS tab: the deploy dialog preselects this script. */
export const vpsDeployRequest: { projectId: string | null } = { projectId: null };
