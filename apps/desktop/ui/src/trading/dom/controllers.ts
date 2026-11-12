import type { DomWindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';

/** Live ladders by window id (commands re-centre / scroll the active DOM through these). */
export const domControllers = new Map<string, { recenter(): void; scroll(rows: number): void }>();

/** Smart DOM data saved with the window (workspace `ext.smartDom`). */
export interface SmartDomExt {
  template?: string;
}

export function smartDomExt(s: DomWindowState): SmartDomExt {
  const e = s.ext?.smartDom;
  return e && typeof e === 'object' ? (e as SmartDomExt) : {};
}

export function setWindowTemplate(windowId: string, templateId: string): void {
  const s = useWindows.getState().windows[windowId];
  if (!s || s.kind !== 'dom') return;
  useWindows.getState().patch(windowId, {
    ext: { ...s.ext, smartDom: { ...smartDomExt(s), template: templateId } },
  });
}

/** The active DOM window, else the first open one. */
export function activeDom(): { id: string; s: DomWindowState } | null {
  const { windows, activeId } = useWindows.getState();
  const a = activeId ? windows[activeId] : undefined;
  if (activeId && a?.kind === 'dom') return { id: activeId, s: a };
  for (const [id, w] of Object.entries(windows)) if (w.kind === 'dom') return { id, s: w };
  return null;
}
