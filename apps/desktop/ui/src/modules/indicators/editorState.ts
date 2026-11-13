import { create } from 'zustand';

export const EDITOR_MODULE = 'script-editor';

/** Which script the Script Editor should show next (null = a new script). */
export const useEditorTarget = create<{ id: string | null; nonce: number }>(() => ({
  id: null,
  nonce: 0,
}));

/** Opens (or focuses) the Script Editor window on a library script, or on a new one. */
export function openScriptEditor(id: string | null): void {
  useEditorTarget.setState((s) => ({ id, nonce: s.nonce + 1 }));
  window.dispatchEvent(
    new CustomEvent('htflow:open-module', { detail: { module: EDITOR_MODULE, position: 'right' } }),
  );
}
