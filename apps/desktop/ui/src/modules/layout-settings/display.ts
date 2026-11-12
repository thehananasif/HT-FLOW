/**
 * Multi-monitor restore (P25 / P37). A workspace remembers where the main window was, which
 * monitors were connected and the screen bounds of every floating window. On load the main window
 * goes back to its monitor (desktop app) — or to the primary one, fully visible, when that monitor is
 * gone — and floating windows are clamped (or scaled, "Fit to screens") into today's docking area.
 *
 * Floating windows live inside the main window (dockview floating groups). True OS windows per
 * panel (Tauri WebviewWindow) are not built yet: each would need its own copy of the market-data
 * hub and window store, synchronised over IPC.
 */
import {
  fitFloatingGroups,
  floatingScreenBounds,
  monitorFor,
  restoreBounds,
  type DisplaySnapshot,
  type MonitorInfo,
  type Rect,
  type RestoreMode,
} from '@htflow/workspace';
import { isTauri } from '../../backend';
import { getSetting } from '../../state/settings';
import { log } from '../../state/log';

const restoreMode = (): RestoreMode =>
  getSetting('layout.restoreMode') === 'fit' ? 'fit' : 'exact';

let monitors: MonitorInfo[] = [];
let mainRect: Rect | null = null;

/** Monitors as the browser sees them (one screen unless the Window Management API is granted). */
function browserMonitors(): MonitorInfo[] {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return [
    {
      name: 'Screen 1',
      x: s.availLeft ?? 0,
      y: s.availTop ?? 0,
      width: s.width,
      height: s.height,
      primary: true,
      scale: window.devicePixelRatio || 1,
    },
  ];
}

function browserMain(): Rect {
  return {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth || window.innerWidth,
    height: window.outerHeight || window.innerHeight,
  };
}

/** Refreshes the cached monitor list and main-window bounds (async in the desktop app). */
export async function refreshDisplay(): Promise<void> {
  if (!isTauri) {
    monitors = browserMonitors();
    mainRect = browserMain();
    return;
  }
  try {
    const w = await import('@tauri-apps/api/window');
    const list = await w.availableMonitors();
    const primary = await w.primaryMonitor();
    monitors = list.map((m, i) => ({
      name: m.name ?? `Monitor ${i + 1}`,
      x: m.position.x,
      y: m.position.y,
      width: m.size.width,
      height: m.size.height,
      primary: !!primary && primary.name === m.name,
      scale: m.scaleFactor,
    }));
    if (monitors.length && !monitors.some((m) => m.primary)) monitors[0]!.primary = true;
    const win = w.getCurrentWindow();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    mainRect = { x: pos.x, y: pos.y, width: size.width, height: size.height };
  } catch (e) {
    log.warn('layout', `Reading monitors failed: ${String(e)}`);
    monitors = browserMonitors();
    mainRect = browserMain();
  }
}

let installed = false;
/** Keeps the cache fresh: at start, on resize and every 5 s (window moves fire no DOM event). */
export function installDisplayTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  void refreshDisplay();
  window.addEventListener('resize', () => void refreshDisplay());
  setInterval(() => void refreshDisplay(), 5000);
}

export function currentMonitors(): MonitorInfo[] {
  return monitors.length ? monitors : typeof window !== 'undefined' ? browserMonitors() : [];
}

/** Snapshot saved with the workspace. `container` is the docking area element. */
export function captureDisplay(layout: unknown, container: HTMLElement | null): DisplaySnapshot {
  const main = mainRect ?? browserMain();
  const box = container?.getBoundingClientRect();
  const size = { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
  // Docking area on screen: window position + its offset inside the window (approximate in
  // browsers: the window chrome height is outer - inner).
  const chrome = Math.max(0, (window.outerHeight || 0) - window.innerHeight);
  const scale = isTauri ? window.devicePixelRatio || 1 : 1;
  const onScreen = {
    x: main.x + Math.round((box?.left ?? 0) * scale),
    y: main.y + Math.round(((box?.top ?? 0) + (isTauri ? 0 : chrome)) * scale),
  };
  const mons = currentMonitors();
  return {
    monitors: mons,
    main,
    container: size,
    windows: floatingScreenBounds(layout, size, onScreen, mons),
  };
}

/**
 * Prepares a saved dockview layout for today's docking area: floating windows are clamped (exact)
 * or scaled (fit), and snapped to the grid when snapping is on.
 */
export function prepareLayout(
  layout: unknown,
  display: DisplaySnapshot | undefined,
  container: { width: number; height: number },
): unknown {
  if (!getSetting('layout.restoreMonitors') && !getSetting('layout.snapToGrid')) return layout;
  if (container.width <= 0 || container.height <= 0) return layout;
  return fitFloatingGroups(layout, container, {
    saved: display?.container,
    mode: getSetting('layout.restoreMonitors') ? restoreMode() : 'exact',
    grid: getSetting('layout.snapToGrid') ? getSetting('layout.gridSize') : 0,
  });
}

/** Where the main window should go for a saved display (pure decision; null = leave it). */
export function mainWindowTarget(display: DisplaySnapshot | undefined): Rect | null {
  if (!display || !getSetting('layout.restoreMonitors')) return null;
  const mons = currentMonitors();
  if (!mons.length) return null;
  const savedMon = monitorFor(display.main, display.monitors) ?? null;
  return restoreBounds(display.main, savedMon, mons, restoreMode()).rect;
}

/** Moves / resizes the main window back to its saved monitor (desktop app only). */
export async function restoreMainWindow(display: DisplaySnapshot | undefined): Promise<void> {
  if (!isTauri) return;
  await refreshDisplay();
  const r = mainWindowTarget(display);
  if (!r || !mainRect) return;
  if (
    r.x === mainRect.x &&
    r.y === mainRect.y &&
    r.width === mainRect.width &&
    r.height === mainRect.height
  )
    return;
  try {
    const w = await import('@tauri-apps/api/window');
    const win = w.getCurrentWindow();
    if (await win.isMaximized()) return;
    await win.setSize(new w.PhysicalSize(r.width, r.height));
    await win.setPosition(new w.PhysicalPosition(r.x, r.y));
    mainRect = r;
  } catch (e) {
    log.warn('layout', `Restoring the window position failed: ${String(e)}`);
  }
}
