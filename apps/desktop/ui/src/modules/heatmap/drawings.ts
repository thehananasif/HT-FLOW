import {
  DrawingController,
  DrawingsLayer,
  deserialize,
  isTool,
  makeProj,
  serialize,
  TimeAxis,
  type Drawing,
  type ToolId,
} from '@htflow/drawings';
import type { ChartCore } from '@htflow/chart-engine';

/** Tools of the Heatmap window's left toolbar (spec P11), in order. */
export const HEATMAP_TOOLS: { id: ToolId; label: string; shortcut?: string }[] = [
  { id: 'trend-line', label: 'Trend line' },
  { id: 'horizontal-line', label: 'Horizontal line' },
  { id: 'vertical-line', label: 'Vertical line' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'parallel-channel', label: 'Channel' },
  { id: 'measure', label: 'Measure' },
  { id: 'text', label: 'Text' },
];

export interface DrawPrefs {
  keep: boolean;
  magnet: boolean;
  magnetPx: number;
  snapTicks: boolean;
}

export const DEFAULT_DRAW_PREFS: DrawPrefs = {
  keep: false,
  magnet: false,
  magnetPx: 8,
  snapTicks: true,
};

/**
 * Drawings on a Heatmap window, using the shared @htflow/drawings engine with storage in the
 * window's params (the chart drawings extension only serves chart windows).
 */
export class HeatDrawings {
  readonly ctrl: DrawingController;
  readonly layer: DrawingsLayer;
  tool: ToolId | null = null;
  selected: string | null = null;
  prefs: DrawPrefs = { ...DEFAULT_DRAW_PREFS };
  private items: Drawing[];
  private listeners = new Set<() => void>();

  constructor(
    private core: ChartCore,
    raw: unknown,
    private persist: (doc: unknown) => void,
    nominalMs: () => number,
    private onText: (d: Drawing) => void,
  ) {
    this.items = deserialize(raw, isTool);
    const axis = new TimeAxis(
      () => core.source.count(),
      (i) => core.source.timeAt(i),
      nominalMs,
    );
    this.ctrl = new DrawingController({
      items: () => this.items,
      save: (next) => {
        this.items = next;
        this.persist(serialize(next));
        this.emit();
      },
      tool: () => this.tool,
      setTool: (t) => {
        this.tool = t;
        this.emit();
      },
      keepDrawing: () => this.prefs.keep,
      magnet: () => ({
        magnet: this.prefs.magnet,
        px: this.prefs.magnetPx,
        snapTicks: this.prefs.snapTicks,
      }),
      proj: (v) => makeProj(v, axis, null, 0),
      selected: () => this.selected,
      select: (id) => {
        this.selected = id;
        this.emit();
      },
      tfKey: () => 'heatmap',
      invalidate: () => core.invalidate(),
      onCreated: (d) => {
        if (d.type === 'text') this.onText(d);
      },
      onEdit: (id) => {
        const d = this.items.find((x) => x.id === id);
        if (d?.type === 'text') this.onText(d);
      },
    });
    this.layer = new DrawingsLayer({
      list: () => this.ctrl.list(),
      selected: () => this.selected,
      proj: (v) => makeProj(v, axis, null, 0),
    });
    core.pointerHandlers.push(this.ctrl);
  }

  list(): Drawing[] {
    return this.items;
  }

  setTool(t: ToolId | null): void {
    this.ctrl.cancel();
    this.tool = this.tool === t ? null : t;
    this.emit();
  }

  setPrefs(p: Partial<DrawPrefs>): void {
    this.prefs = { ...this.prefs, ...p };
    this.emit();
  }

  update(id: string, fn: (d: Drawing) => Drawing): void {
    this.ctrl.update(id, fn);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.core.invalidate();
    for (const l of this.listeners) l();
  }

  dispose(): void {
    const i = this.core.pointerHandlers.indexOf(this.ctrl);
    if (i >= 0) this.core.pointerHandlers.splice(i, 1);
    this.listeners.clear();
  }
}
