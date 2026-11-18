import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  BarChart2,
  ChevronRight,
  Circle,
  Gauge,
  List,
  Minus,
  MoreHorizontal,
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

import { translateLiteral as tl, tt } from '@htflow/i18n';
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
  // Short windows: tool groups that do not fit move into a "More tools" overflow flyout, so the
  // last tools stay reachable. Shrink until the rail fits; start over when the height changes.
  const [fit, setFit] = useState(groups.length);
  // Last resort: the footprint mode tabs fold into the overflow flyout as well.
  const [fpFold, setFpFold] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1) return;
    if (fit > 0) setFit((n) => n - 1);
    else if (showFootprint && !fpFold) setFpFold(true);
  }, [fit, fpFold, groups.length, showFootprint]);
  useEffect(() => {
    setFit(groups.length);
    setFpFold(false);
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight !== h) {
        h = el.clientHeight;
        setFit(groups.length);
        setFpFold(false);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [groups.length]);
  const shown = fit >= groups.length ? groups : groups.slice(0, Math.max(0, fit - 1));
  const hidden = groups.slice(shown.length);
  const fpHidden = showFootprint && fpFold;
  // Flyouts of buttons in the lower half of the window open upwards (bottom-aligned).
  const [flyStyle, setFlyStyle] = useState<CSSProperties | undefined>(undefined);
  const toggle = (id: string, btn: HTMLElement) => {
    if (open === id) return setOpen(null);
    const r = btn.getBoundingClientRect();
    setFlyStyle(
      r.top > window.innerHeight / 2
        ? { top: 'auto', bottom: 0, maxHeight: Math.max(160, r.bottom - 8) }
        : { maxHeight: Math.max(160, window.innerHeight - r.top - 8) },
    );
    setOpen(id);
  };
  const fpFlyout = (g: (typeof FOOTPRINT_GROUPS)[number]) => (
    <div className="st-flyout" role="menu" aria-label={g} style={flyStyle}>
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
          {tl(m.label)}
          {m.shortcut && <span className="ht-menu-sc">{m.shortcut}</span>}
        </button>
      ))}
    </div>
  );
  const flyout = (g: (typeof DRAW_GROUPS)[number]) => (
    <div
      className="st-flyout"
      role="menu"
      aria-label={toolbarGroupLabel(g.id, g.label)}
      style={flyStyle}
    >
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
            {!def.ready && <span className="ht-menu-sc">{tk('drawings.pending', 'pending')}</span>}
            {def.ready && def.shortcut && <span className="ht-menu-sc">{def.shortcut}</span>}
          </button>
        );
      })}
      {g.id === 'objects' && (
        <>
          <button className="st-item" role="menuitem" onClick={act(openObjectsList)}>
            <span className="st-check" />
            {tl('Objects List')}
          </button>
          <button
            className="st-item"
            role="menuitemcheckbox"
            aria-checked={prefs.keep ? 'mixed' : false}
            onClick={() => useDrawUi.getState().setPrefs({ keep: !prefs.keep })}
          >
            <span className="st-check">{prefs.keep ? '✓' : ''}</span>
            {tl('Keep Drawing')}
          </button>
          <button
            className="st-item"
            role="menuitemcheckbox"
            aria-checked={prefs.magnet ? 'mixed' : false}
            onClick={() => useDrawUi.getState().setPrefs({ magnet: !prefs.magnet })}
          >
            <span className="st-check">{prefs.magnet ? '✓' : ''}</span>
            {tl('Magnet (OHLC / clusters)')}
            <span className="ht-menu-sc">
              {prefs.magnetPx} {tl('px')}
            </span>
          </button>
          <button
            className="st-item"
            role="menuitem"
            onClick={act(() => void ctrl()?.removeSelected())}
          >
            <span className="st-check" />
            {tl('Delete selected')}
            <span className="ht-menu-sc">{tl('Del')}</span>
          </button>
          <button className="st-item" role="menuitem" onClick={act(() => ctrl()?.removeAll())}>
            <span className="st-check" />
            {tl('Delete all drawings')}
          </button>
          <button className="st-item" role="menuitem" onClick={act(() => void ctrl()?.undo())}>
            <span className="st-check" />
            {tl('Undo')}
            <span className="ht-menu-sc">{tl('Ctrl+Z')}</span>
          </button>
          <button className="st-item" role="menuitem" onClick={act(() => void ctrl()?.redo())}>
            <span className="st-check" />
            {tl('Redo')}
            <span className="ht-menu-sc">{tl('Ctrl+Y')}</span>
          </button>
          <button className="st-item" disabled title={tl('Arrives with the indicators phase')}>
            <span className="st-check" />
            {tl('Remove indicators')}
            <span className="ht-menu-sc">{tl('pending')}</span>
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className="sidetools" ref={ref} data-testid="sidetools">
      <button
        className="st-btn"
        aria-label={tl('Footprint quick settings')}
        title={tl('Footprint quick settings')}
        onClick={onSettings}
      >
        <SlidersHorizontal size={15} />
      </button>
      {showFootprint && !fpHidden && (
        <>
          <div className="st-sep" />
          {FOOTPRINT_GROUPS.map((g) => (
            <div key={g} className="st-rel">
              <button
                className="st-vtab"
                data-active={g === active || undefined}
                aria-expanded={open === g}
                onClick={(e) => toggle(g, e.currentTarget)}
              >
                {g} ›
              </button>
              {open === g && fpFlyout(g)}
            </div>
          ))}
        </>
      )}
      <div className="st-sep" />
      {shown.map((g) => (
        <div key={g.id} className="st-rel">
          <button
            className="st-btn"
            aria-label={toolbarGroupLabel(g.id, g.label)}
            title={toolbarGroupLabel(g.id, g.label)}
            aria-expanded={open === g.id}
            data-has-tool={(tool && g.tools.includes(tool)) || undefined}
            onClick={(e) => toggle(g.id, e.currentTarget)}
          >
            <g.icon size={15} />
            <ChevronRight size={7} className="st-chev" />
          </button>
          {open === g.id && flyout(g)}
        </div>
      ))}
      {(hidden.length > 0 || fpHidden) && (
        <div className="st-rel">
          <button
            className="st-btn"
            aria-label={tl('More tools')}
            title={tt`More tools: ${[
              ...(fpHidden ? FOOTPRINT_GROUPS : []),
              ...hidden.map((g) => toolbarGroupLabel(g.id, g.label)),
            ].join(', ')}`}
            data-testid="sidetools-more"
            aria-expanded={
              open === 'more' ||
              hidden.some((g) => g.id === open) ||
              (fpHidden && FOOTPRINT_GROUPS.some((g) => g === open))
            }
            onClick={(e) => toggle('more', e.currentTarget)}
          >
            <MoreHorizontal size={15} />
          </button>
          {open === 'more' && (
            <div className="st-flyout" role="menu" aria-label={tl('More tools')} style={flyStyle}>
              <div className="ht-menu-label">{tl('More tools')}</div>
              {fpHidden &&
                FOOTPRINT_GROUPS.map((g) => (
                  <button key={g} className="st-item" role="menuitem" onClick={() => setOpen(g)}>
                    <span className="st-check">{g === active ? '•' : ''}</span>
                    {g}
                    <ChevronRight size={10} className="ht-menu-sc" />
                  </button>
                ))}
              {hidden.map((g) => (
                <button
                  key={g.id}
                  className="st-item"
                  role="menuitem"
                  onClick={() => setOpen(g.id)}
                >
                  <span className="st-check">
                    <g.icon size={12} />
                  </span>
                  {toolbarGroupLabel(g.id, g.label)}
                  <ChevronRight size={10} className="ht-menu-sc" />
                </button>
              ))}
            </div>
          )}
          {hidden.map((g) => open === g.id && <div key={g.id}>{flyout(g)}</div>)}
          {fpHidden && FOOTPRINT_GROUPS.map((g) => open === g && <div key={g}>{fpFlyout(g)}</div>)}
        </div>
      )}
    </div>
  );
}
