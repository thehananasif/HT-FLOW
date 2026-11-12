/**
 * "Clone window" and "Create linked window ▸" (P25) for chart, DOM, tape and module windows.
 * New windows are opened through the Dashboard's `htflow:open-window` event.
 */
import type { MenuEntry } from '@htflow/ui-kit';
import {
  cloneWindowState,
  LINK_COLOR_IDS,
  LINKED_KINDS,
  linkedWindowState,
  setWindowLink,
  windowLink,
  type LinkColor,
  type LinkedKind,
  type WindowState,
} from '@htflow/workspace';
import { activeInstrument, useWindows } from '../../state/windows';
import { DEFAULT_INSTRUMENT } from '../../state/instruments';
import { workspaceHost } from './host';

export type OpenDir = 'right' | 'below' | 'left' | 'above' | 'within';

/** Detail of the `htflow:open-window` event (a bare WindowState is accepted too). */
export interface OpenWindowDetail {
  state: WindowState;
  /** Window to place the new one next to (default: the active window). */
  ref?: string;
  dir?: OpenDir;
  /** Force floating / docked; default follows Layout settings → New windows. */
  floating?: boolean;
}

export function openWindow(detail: OpenWindowDetail): void {
  window.dispatchEvent(new CustomEvent<OpenWindowDetail>('htflow:open-window', { detail }));
}

/** Reads either form of the event detail. */
export function readOpenWindowDetail(detail: unknown): OpenWindowDetail | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.kind === 'string') return { state: d as unknown as WindowState };
  if (
    d.state &&
    typeof d.state === 'object' &&
    typeof (d.state as { kind?: unknown }).kind === 'string'
  )
    return d as unknown as OpenWindowDetail;
  return null;
}

const target = (id?: string | null) => id ?? useWindows.getState().activeId;

/** Duplicates a window with all its settings, next to it. */
export function cloneWindow(id?: string | null): boolean {
  const wid = target(id);
  const s = wid ? useWindows.getState().windows[wid] : undefined;
  if (!wid || !s) return false;
  openWindow({ state: cloneWindowState(s), ref: wid, dir: 'right' });
  return true;
}

/** Opens a new window of `kind` on the same instrument and link group as window `id`. */
export function createLinkedWindow(kind: LinkedKind, id?: string | null): boolean {
  const { windows, patch } = useWindows.getState();
  const wid = target(id);
  const src = wid ? windows[wid] : undefined;
  if (!wid || !src) return false;
  const { state, sourceLink } = linkedWindowState(
    src,
    kind,
    windows,
    activeInstrument() ?? DEFAULT_INSTRUMENT,
  );
  if (sourceLink) patch(wid, setWindowLink(src, sourceLink) as Partial<WindowState>);
  openWindow({ state, ref: wid, dir: 'right' });
  return true;
}

export function setLink(id: string, link: LinkColor): void {
  const s = useWindows.getState().windows[id];
  if (s) useWindows.getState().patch(id, setWindowLink(s, link) as Partial<WindowState>);
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Menu shown in every window header (⋯) and reused by the chart context menu. */
export function windowMenuItems(id: string): MenuEntry[] {
  const s = useWindows.getState().windows[id];
  if (!s) return [];
  const host = workspaceHost();
  const link = windowLink(s);
  return [
    {
      kind: 'submenu',
      id: 'linked',
      label: 'Create linked window',
      items: LINKED_KINDS.map((k) => ({
        id: k.id,
        label: k.label,
        onSelect: () => void createLinkedWindow(k.id, id),
      })),
    },
    { id: 'clone', label: 'Clone window', onSelect: () => void cloneWindow(id) },
    {
      kind: 'submenu',
      id: 'link',
      label: 'Link group',
      items: LINK_COLOR_IDS.map((c) => ({
        id: c,
        label: c === 'none' ? 'No link' : cap(c),
        checked: c === link,
        onSelect: () => setLink(id, c),
      })),
    },
    { kind: 'separator', id: 's' },
    {
      id: 'float',
      label: host?.isFloating?.(id) ? 'Dock window' : 'Float window',
      disabled: !host?.toggleFloating,
      onSelect: () => host?.toggleFloating?.(id),
    },
  ];
}
