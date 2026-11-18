/**
 * Applies the `layout.*` settings (P25 / P37) to the running app: link-group colours, header
 * density / style, layout-tab position and ribbon visibility (document attributes + CSS), and to
 * the dock itself: gap, lock, grid snapping of floating windows, and where new windows open.
 */
import type { DockviewApi, DockviewTheme, IDockviewPanel } from 'dockview';
import {
  LINK_COLOR_IDS,
  openModeType,
  snapRect,
  type LinkColor,
  type Rect,
  type WindowState,
} from '@htflow/workspace';
import {
  getSetting,
  getSettings,
  onSettingChange,
  useSettingsStore,
  type SettingKey,
  type SettingsValues,
} from '../../state/settings';
import { isTauri } from '../../backend';

export const LINK_SETTING: Record<Exclude<LinkColor, 'none'>, SettingKey> = {
  red: 'layout.linkRed',
  green: 'layout.linkGreen',
  blue: 'layout.linkBlue',
  yellow: 'layout.linkYellow',
  purple: 'layout.linkPurple',
};

export const OPEN_SETTING = {
  chart: 'layout.openChart',
  dom: 'layout.openDom',
  tape: 'layout.openTape',
  module: 'layout.openModule',
} as const satisfies Record<string, SettingKey>;

/** Document-level part: CSS custom properties and data attributes read by styles.css. */
export function applyLayoutDocument(v: SettingsValues): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  for (const c of LINK_COLOR_IDS) {
    if (c === 'none') continue;
    const val = v[LINK_SETTING[c]] as string;
    if (val) el.style.setProperty(`--ht-link-${c}`, val);
    else el.style.removeProperty(`--ht-link-${c}`);
  }
  el.dataset.htHeader = v['layout.headerDensity'];
  el.dataset.htHeaderStyle = v['layout.headerStyle'];
  el.dataset.htLayoutTabs = v['layout.tabPosition'];
  el.classList.toggle('ht-ribbon-hidden', v['layout.ribbonHidden']);
}

let installed = false;
export function installLayoutEffects(): void {
  if (installed) return;
  installed = true;
  applyLayoutDocument(getSettings());
  useSettingsStore.subscribe(() => applyLayoutDocument(getSettings()));
}

// ------------------------------------------------------------------ dock behaviour

interface FloatingGroupLike {
  group: { id: string; panels: { id: string }[] };
  overlay: {
    toJSON(): { top?: number; left?: number; width: number; height: number };
    onDidChangeEnd?: (fn: () => void) => { dispose(): void };
  };
  position(b: { top: number; left: number; width: number; height: number }): void;
}

/** Floating groups of the dock (dockview keeps them on its component). */
export function floatingGroups(api: DockviewApi): FloatingGroupLike[] {
  const comp = (api as unknown as { component?: { floatingGroups?: unknown } }).component;
  const list = comp?.floatingGroups;
  return Array.isArray(list) ? (list as FloatingGroupLike[]) : [];
}

export function isFloating(api: DockviewApi, panelId: string): boolean {
  return api.getPanel(panelId)?.group.api.location.type === 'floating';
}

/** Snaps every floating window to the grid (when enabled). */
export function snapFloating(api: DockviewApi): void {
  if (!getSetting('layout.snapToGrid')) return;
  const grid = getSetting('layout.gridSize');
  for (const fg of floatingGroups(api)) {
    const b = fg.overlay.toJSON();
    if (typeof b.left !== 'number' || typeof b.top !== 'number') continue;
    const r = snapRect({ x: b.left, y: b.top, width: b.width, height: b.height }, grid);
    if (r.x !== b.left || r.y !== b.top || r.width !== b.width || r.height !== b.height)
      fg.position({ left: r.x, top: r.y, width: r.width, height: r.height });
  }
}

/**
 * Hooks the dock up to the layout settings: gap, lock, and snapping floating windows after a drag
 * or resize. Returns a disposer.
 */
export function attachDockBehaviour(api: DockviewApi, theme: DockviewTheme): () => void {
  const apply = () => {
    const lock = getSetting('layout.lock');
    api.updateOptions({
      theme: { ...theme, gap: getSetting('layout.gap') },
      disableDnd: lock,
      locked: lock,
    });
  };
  apply();
  const offs = [
    onSettingChange('layout.gap', apply),
    onSettingChange('layout.lock', apply),
    onSettingChange('layout.snapToGrid', () => snapFloating(api)),
    onSettingChange('layout.gridSize', () => snapFloating(api)),
  ];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = api.onDidLayoutChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => snapFloating(api), 250);
  });
  return () => {
    offs.forEach((o) => o());
    sub.dispose();
    if (timer) clearTimeout(timer);
  };
}

// ------------------------------------------------------------------ new windows

let cascade = 0;

/** Rectangle of a new floating window inside a docking area of `area` size (pure). */
export function floatingRect(
  area: { width: number; height: number },
  size: { width: number; height: number },
  placement: string,
  step: number,
  grid = 0,
): Rect {
  const width = Math.min(size.width, Math.max(160, area.width - 16));
  const height = Math.min(size.height, Math.max(120, area.height - 16));
  let x = 24;
  let y = 24;
  if (placement === 'center') {
    x = (area.width - width) / 2;
    y = (area.height - height) / 2;
  } else if (placement === 'cascade') {
    const n = step % 8;
    x = 60 + n * 28;
    y = 40 + n * 28;
  }
  x = Math.max(0, Math.min(x, area.width - width));
  y = Math.max(0, Math.min(y, area.height - height));
  const r = { x: Math.round(x), y: Math.round(y), width, height };
  return grid > 1 ? snapRect(r, grid) : r;
}

export function defaultFloatingRect(api: DockviewApi): Rect {
  return floatingRect(
    { width: api.width, height: api.height },
    { width: getSetting('layout.newWindowWidth'), height: getSetting('layout.newWindowHeight') },
    getSetting('layout.floatPlacement'),
    cascade++,
    getSetting('layout.snapToGrid') ? getSetting('layout.gridSize') : 0,
  );
}

/** Whether a new window of this type opens floating (Layout settings → New windows). */
export function opensFloating(state: WindowState): boolean {
  const mode = getSetting(OPEN_SETTING[openModeType(state)]);
  // "New OS window" floats in the browser build (no second native window there).
  return mode === 'floating' || (mode === 'window' && !isTauri);
}

/** Whether a new window of this type opens in its own OS window (desktop app only). */
export function opensOsWindow(state: WindowState): boolean {
  return isTauri && getSetting(OPEN_SETTING[openModeType(state)]) === 'window';
}

/**
 * Where "Split right / down" puts the copy of a floating window: a floating window of the same
 * size next to it (floating groups cannot be split), kept inside the docking area (pure).
 */
export function splitFloatingRect(
  src: Rect,
  dir: 'right' | 'below',
  area: { width: number; height: number },
  gap = 8,
): Rect {
  const width = Math.min(src.width, area.width);
  const height = Math.min(src.height, area.height);
  let x = dir === 'right' ? src.x + src.width + gap : src.x;
  let y = dir === 'below' ? src.y + src.height + gap : src.y;
  // No room on that side: overlap with an offset instead of leaving the docking area.
  if (x + width > area.width) x = Math.max(0, Math.min(src.x + 32, area.width - width));
  if (y + height > area.height) y = Math.max(0, Math.min(src.y + 32, area.height - height));
  return { x, y, width, height };
}

export interface PlaceOptions {
  id: string;
  state: WindowState;
  title: string;
  /** Reference window and direction requested by the caller (e.g. Clone: right of the source). */
  ref?: string;
  dir?: 'right' | 'below' | 'left' | 'above' | 'within';
  floating?: boolean;
}

/**
 * Adds a panel for a new window, docked or floating, where Layout settings say (an explicit ref /
 * dir / floating from the caller wins). Returns the panel.
 */
export function placeNewWindow(api: DockviewApi, o: PlaceOptions): IDockviewPanel {
  const floating = o.floating ?? opensFloating(o.state);
  const base = { id: o.id, component: o.state.kind, title: o.title };
  if (floating) {
    const r = defaultFloatingRect(api);
    return api.addPanel({
      ...base,
      floating: { position: { left: r.x, top: r.y }, width: r.width, height: r.height },
    });
  }
  const refPanel = (o.ref && api.getPanel(o.ref)) || api.activePanel;
  if (!refPanel) return api.addPanel(base);
  // A floating reference: open docked in the grid instead of inside the floating group.
  if (refPanel.group.api.location.type !== 'grid' && !o.dir) return api.addPanel(base);
  const placement = getSetting('layout.dockPlacement');
  const direction = (o.dir ?? (placement === 'tab' ? 'within' : placement)) as NonNullable<
    PlaceOptions['dir']
  >;
  return api.addPanel({ ...base, position: { referencePanel: refPanel, direction } });
}

/** Floats a docked window (default size), or docks a floating one to the right of the grid. */
export function toggleFloating(api: DockviewApi, id: string): void {
  const panel = api.getPanel(id);
  if (!panel) return;
  if (panel.group.api.location.type === 'grid') {
    const r = defaultFloatingRect(api);
    api.addFloatingGroup(panel, {
      position: { left: r.x, top: r.y },
      width: r.width,
      height: r.height,
    });
  } else {
    const anchor = api.groups.find((g) => g.api.location.type === 'grid');
    if (anchor) panel.api.moveTo({ group: anchor, position: 'right' });
  }
}
