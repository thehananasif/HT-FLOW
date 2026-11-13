/**
 * User indicator scripts (`.htind`, P13): a per-user library persisted with backend.saveSettings.
 * Every script is registered as indicator `script:<id>` so charts, the Indicators dialog and the
 * worker pool can use it. The worker compiles its own copy from the source (sandboxed
 * interpreter); the main thread compiles one too for the definition (inputs / outputs).
 */
import { create } from 'zustand';
import { SCRIPT_PREFIX, scriptIndicator, slugId, type HtindFile } from '@htflow/indicator-sdk';
import { registerIndicator, unregisterIndicator } from '@htflow/indicators';
import { backend } from '../../backend';
import { useSession } from '../../state/session';

const KEY = 'indicators.scripts';

interface ScriptsState {
  scripts: HtindFile[];
  /** Upserts a script (by id) and registers it. Throws on a compile error. */
  save(f: HtindFile): void;
  remove(id: string): void;
}

function register(f: HtindFile): boolean {
  unregisterIndicator(SCRIPT_PREFIX + f.id);
  try {
    registerIndicator(scriptIndicator(SCRIPT_PREFIX + f.id, f.source, f.name));
    return true;
  } catch {
    return false;
  }
}

export const useScripts = create<ScriptsState>((set, get) => ({
  scripts: [],
  save(f) {
    // Compile first: a broken script is never stored.
    scriptIndicator(SCRIPT_PREFIX + f.id, f.source, f.name);
    const next = [...get().scripts.filter((s) => s.id !== f.id), { ...f, updated: Date.now() }];
    next.sort((a, b) => a.name.localeCompare(b.name));
    register(f);
    set({ scripts: next });
    void backend.saveSettings(KEY, next);
  },
  remove(id) {
    unregisterIndicator(SCRIPT_PREFIX + id);
    const next = get().scripts.filter((s) => s.id !== id);
    set({ scripts: next });
    void backend.saveSettings(KEY, next);
  },
}));

/** A free id for a new script name. */
export function uniqueScriptId(name: string, except?: string): string {
  const base = slugId(name);
  const taken = new Set(
    useScripts
      .getState()
      .scripts.filter((s) => s.id !== except)
      .map((s) => s.id),
  );
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
  return id;
}

/** Source of a script indicator id (`script:<id>`), for the worker pool. */
export function scriptSource(type: string): { source: string; name: string } | undefined {
  if (!type.startsWith(SCRIPT_PREFIX)) return undefined;
  const f = useScripts.getState().scripts.find((s) => SCRIPT_PREFIX + s.id === type);
  return f ? { source: f.source, name: f.name } : undefined;
}

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  for (const s of useScripts.getState().scripts) unregisterIndicator(SCRIPT_PREFIX + s.id);
  useScripts.setState({ scripts: [] });
  if (!id) return;
  void backend.loadSettings<HtindFile[]>(KEY).then((saved) => {
    const list = Array.isArray(saved) ? saved.filter((f) => f && typeof f.source === 'string') : [];
    useScripts.setState({ scripts: list.filter(register) });
  });
}
useSession.subscribe(onSession);
onSession();
