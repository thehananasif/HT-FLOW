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
import { isTauri } from '../../backend';
import { osWindowOf, reattachWindow } from '../../platform/osWindows';

export type OpenDir = 'right' | 'below' | 'left' | 'above' | 'within';

/** Detail of the `htflow:open-window` event (a bare WindowState is accepted too). */
export interface OpenWindowDetail {
  state: WindowState;
  /** Window to place the new one next to (default: the active window). */
  ref?: string;
  dir?: OpenDir;
  /** Force floating / docked; default follows Layout settings → New windows. */
  floating?: boolean;
  /** Open in a new OS window (desktop app; the browser build floats it instead). */
  osWindow?: boolean;
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
export function cloneWindow(id?: string | null, osWindow = false): boolean {
  const wid = target(id);
  const s = wid ? useWindows.getState().windows[wid] : undefined;
  if (!wid || !s) return false;
  openWindow(
    osWindow
      ? { state: cloneWindowState(s), osWindow: true }
      : { state: cloneWindowState(s), ref: wid, dir: 'right' },
  );
  return true;
}

/** Opens a new window of `kind` on the same instrument and link group as window `id`. */
export function createLinkedWindow(
  kind: LinkedKind,
  id?: string | null,
  osWindow = false,
): boolean {
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
  openWindow(osWindow ? { state, osWindow: true } : { state, ref: wid, dir: 'right' });
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
  const inOs = osWindowOf(id) !== null;
  const osHint = isTauri ? '' : ' (floating in a browser)';
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
    {
      kind: 'submenu',
      id: 'linked-os',
      label: 'Create linked window in new OS window',
      items: LINKED_KINDS.map((k) => ({
        id: `os-${k.id}`,
        label: `${k.label}${osHint}`,
        onSelect: () => void createLinkedWindow(k.id, id, true),
      })),
    },
    { id: 'clone', label: 'Clone window', onSelect: () => void cloneWindow(id) },
    {
      id: 'clone-os',
      label: `Clone window in new OS window${osHint}`,
      onSelect: () => void cloneWindow(id, true),
    },
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
    inOs
      ? { id: 'reattach', label: 'Re-attach to main window', onSelect: () => reattachWindow(id) }
      : {
          id: 'detach-os',
          label: `Detach to OS window${osHint}`,
          disabled: !host?.detachWindow,
          onSelect: () => host?.detachWindow?.(id, 'os'),
        },
  ];
}
