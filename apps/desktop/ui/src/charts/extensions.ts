import type { ComponentType } from 'react';
import type { BarSeries, MarketStore } from '@htflow/market-data';
import type { ChartCore, ChartLayer } from '@htflow/chart-engine';
import type { MenuEntry } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';

/** What a chart extension gets for one chart window. */
export interface ChartExtensionContext {
  windowId: string;
  store: MarketStore;
  /** Current window state (always fresh). */
  state(): ChartWindowState;
  /** Main bar series for bar-based templates; null for the liquidity map. */
  series(): BarSeries | null;
  /** The core that shows bars (left core for Order Flow). */
  core: ChartCore;
  cores: ChartCore[];
  /** Persist extension data under state.ext[extensionId]. */
  setExt(value: unknown): void;
}

export interface ChartExtension {
  id: string;
  /** Extra layers for the main core; called whenever the chart is (re)built. */
  layers?(ctx: ChartExtensionContext): ChartLayer[];
  /** Called once per build; return a disposer. Use for pointer handlers, subscriptions, … */
  attach?(ctx: ChartExtensionContext): (() => void) | void;
  /** Extra right-click items at the cursor price (ticks). */
  menu?(ctx: ChartExtensionContext, px: number | null): MenuEntry[];
  /** React overlay rendered over the chart area (toolbars, dialogs). */
  Overlay?: ComponentType<{ windowId: string; state: ChartWindowState }>;
}

/** Items rendered in every chart window header (before the centre label). */
export interface HeaderItem {
  id: string;
  order?: number;
  Component: ComponentType<{ windowId: string; state: ChartWindowState }>;
}

const extensions: ChartExtension[] = [];
const headerItems: HeaderItem[] = [];

export function registerChartExtension(ext: ChartExtension): void {
  const i = extensions.findIndex((e) => e.id === ext.id);
  if (i >= 0) extensions[i] = ext;
  else extensions.push(ext);
}

export function chartExtensions(): ChartExtension[] {
  return extensions;
}

export function registerHeaderItem(item: HeaderItem): void {
  const i = headerItems.findIndex((h) => h.id === item.id);
  if (i >= 0) headerItems[i] = item;
  else headerItems.push(item);
  headerItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function chartHeaderItems(): HeaderItem[] {
  return headerItems;
}
