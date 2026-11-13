import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BarChart2,
  ChevronRight,
  Circle,
  Gauge,
  List,
  Minus,
  PencilRuler,
  Shapes,
  SlidersHorizontal,
  Spline,
  Type,
  Waves,
} from 'lucide-react';
import { FOOTPRINT_GROUPS, FOOTPRINT_MODES, footprintMode } from '@htflow/footprint';
import { toolDef, toolsIn, type ToolGroup, type ToolId } from '@htflow/drawings';
import { activateTool, controllers, openObjectsList, useDrawUi } from '../modules/drawings/store';
import { tk, toolbarGroupLabel, toolLabel, toolNote } from '../modules/drawings/toolText';

/** Drawing groups (P45): each flyout lists tools of @htflow/drawings (P12). */
const DRAW_GROUPS: { id: string; label: string; icon: typeof Minus; tools: ToolId[] }[] = [
  { id: 'lines', label: 'Lines', icon: Minus, tools: ids('lines') },
  {
    id: 'shapes',
    label: 'Shapes',
    icon: Shapes,
    tools: [
      ...ids('shapes').filter((t) => !t.startsWith('highlight')),
      ...ids('channels'),
      'highlight-y',
      'highlight-x',
    ],
  },
  { id: 'volume', label: 'Volume Analysis', icon: BarChart2, tools: ids('volume') },
  { id: 'fib', label: 'Fibonacci', icon: Spline, tools: ids('fib') },
  { id: 'measure', label: 'Measurement', icon: PencilRuler, tools: ids('measure') },
  { id: 'elliott', label: 'Elliott Waves', icon: Waves, tools: ids('elliott') },
  { id: 'markers', label: 'Chart Markers', icon: Circle, tools: ids('markers') },
  { id: 'text', label: 'Text', icon: Type, tools: ids('text') },
  { id: 'positions', label: 'Positions', icon: ArrowUpRight, tools: ids('risk') },
  { id: 'gann', label: 'Gann & Pitchfork', icon: Gauge, tools: ids('gann') },
  { id: 'objects', label: 'Objects', icon: List, tools: [] },
];

function ids(group: ToolGroup): ToolId[] {
  return toolsIn(group).map((t) => t.id);
}

export function SideTools({
  windowId,
  mode,
  onMode,
  showFootprint,
  onSettings,
  compact,
}: {
  /** Chart window the drawing tools act on. */
  windowId?: string;
  mode: string;
  onMode: (id: string) => void;
  showFootprint: boolean;
  onSettings: () => void;
  compact: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = footprintMode(mode).group;
  const tool = useDrawUi((st) => (windowId ? (st.tool[windowId] ?? null) : null));
  const prefs = useDrawUi((st) => st.prefs);
  const ctrl = () => (windowId ? controllers.get(windowId)?.ctrl : undefined);
  const act = (fn: () => void) => () => {
    fn();
    setOpen(null);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const groups = compact
    ? DRAW_GROUPS.filter((g) =>
        ['lines', 'shapes', 'volume', 'fib', 'text', 'objects'].includes(g.id),
      )
    : DRAW_GROUPS;
  return (
    <div className="sidetools" ref={ref} data-testid="sidetools">
      <button
        className="st-btn"
        aria-label="Footprint quick settings"
        title="Footprint quick settings"
        onClick={onSettings}
      >
        <SlidersHorizontal size={15} />
      </button>
      {showFootprint && (
        <>
          <div className="st-sep" />
          {FOOTPRINT_GROUPS.map((g) => (
            <div key={g} className="st-rel">
              <button
                className="st-vtab"
                data-active={g === active || undefined}
                aria-expanded={open === g}
                onClick={() => setOpen(open === g ? null : g)}
              >
                {g} ›
              </button>
              {open === g && (
                <div className="st-flyout" role="menu" aria-label={g}>
                  <div className="ht-menu-label">{g}</div>
                  {FOOTPRINT_MODES.filter((m) => m.group === g).map((m) => (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={m.id === mode}
                      className="st-item"
                      onClick={() => {
                        onMode(m.id);
                        setOpen(null);
                      }}
                    >
                      <span className="st-check">{m.id === mode ? '✓' : ''}</span>
                      {m.label}
                      {m.shortcut && <span className="ht-menu-sc">{m.shortcut}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
      <div className="st-sep" />
      {groups.map((g) => (
        <div key={g.id} className="st-rel">
          <button
            className="st-btn"
            aria-label={toolbarGroupLabel(g.id, g.label)}
            title={toolbarGroupLabel(g.id, g.label)}
            aria-expanded={open === g.id}
            data-has-tool={(tool && g.tools.includes(tool)) || undefined}
            onClick={() => setOpen(open === g.id ? null : g.id)}
          >
            <g.icon size={15} />
            <ChevronRight size={7} className="st-chev" />
          </button>
          {open === g.id && (
            <div className="st-flyout" role="menu" aria-label={toolbarGroupLabel(g.id, g.label)}>
              <div className="ht-menu-label">{toolbarGroupLabel(g.id, g.label)}</div>
              {g.tools.map((id) => {
                const def = toolDef(id)!;
                return (
                  <button
                    key={id}
                    role="menuitemradio"
                    aria-checked={tool === id}
                    className="st-item"
                    disabled={!def.ready}
                    title={toolNote(id)}
                    onClick={act(() => activateTool(id, windowId))}
                  >
                    <span className="st-check" />
                    {toolLabel(id)}
                    {!def.ready && (
                      <span className="ht-menu-sc">{tk('drawings.pending', 'pending')}</span>
                    )}
                    {def.ready && def.shortcut && (
                      <span className="ht-menu-sc">{def.shortcut}</span>
                    )}
                  </button>
                );
              })}
              {g.id === 'objects' && (
                <>
                  <button className="st-item" role="menuitem" onClick={act(openObjectsList)}>
                    <span className="st-check" />
                    Objects List
                  </button>
                  <button
                    className="st-item"
                    role="menuitemcheckbox"
                    aria-checked={prefs.keep ? 'mixed' : false}
                    onClick={() => useDrawUi.getState().setPrefs({ keep: !prefs.keep })}
                  >
                    <span className="st-check">{prefs.keep ? '✓' : ''}</span>
                    Keep Drawing
                  </button>
                  <button
                    className="st-item"
                    role="menuitemcheckbox"
                    aria-checked={prefs.magnet ? 'mixed' : false}
                    onClick={() => useDrawUi.getState().setPrefs({ magnet: !prefs.magnet })}
                  >
                    <span className="st-check">{prefs.magnet ? '✓' : ''}</span>
                    Magnet (OHLC / clusters)
                    <span className="ht-menu-sc">{prefs.magnetPx} px</span>
                  </button>
                  <button
                    className="st-item"
                    role="menuitem"
                    onClick={act(() => void ctrl()?.removeSelected())}
                  >
                    <span className="st-check" />
                    Delete selected
                    <span className="ht-menu-sc">Del</span>
                  </button>
                  <button
                    className="st-item"
                    role="menuitem"
                    onClick={act(() => ctrl()?.removeAll())}
                  >
                    <span className="st-check" />
                    Delete all drawings
                  </button>
                  <button
                    className="st-item"
                    role="menuitem"
                    onClick={act(() => void ctrl()?.undo())}
                  >
                    <span className="st-check" />
                    Undo
                    <span className="ht-menu-sc">Ctrl+Z</span>
                  </button>
                  <button
                    className="st-item"
                    role="menuitem"
                    onClick={act(() => void ctrl()?.redo())}
                  >
                    <span className="st-check" />
                    Redo
                    <span className="ht-menu-sc">Ctrl+Y</span>
                  </button>
                  <button className="st-item" disabled title="Arrives with the indicators phase">
                    <span className="st-check" />
                    Remove indicators
                    <span className="ht-menu-sc">pending</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
