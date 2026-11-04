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

/** Drawing groups (P45). Tools themselves arrive with P12 — items are listed with shortcuts but disabled. */
const DRAW_GROUPS: { id: string; label: string; icon: typeof Minus; items: [string, string?][] }[] =
  [
    {
      id: 'lines',
      label: 'Lines',
      icon: Minus,
      items: [
        ['Trend Line', 'F2'],
        ['Trend Angle'],
        ['Vertical Line', 'F7'],
        ['Horizontal Line', 'F6'],
        ['Horizontal Ray'],
        ['Cross Line'],
        ['Brush'],
      ],
    },
    {
      id: 'shapes',
      label: 'Shapes',
      icon: Shapes,
      items: [
        ['Triangle', 'F11'],
        ['Rectangle', 'F12'],
        ['Ellipse'],
        ['Channel'],
        ['Highlight Y'],
        ['Highlight X'],
      ],
    },
    {
      id: 'volume',
      label: 'Volume Analysis',
      icon: BarChart2,
      items: [
        ['Volume Profile & TPO', 'F3'],
        ['Fixed VP & TPO', 'Ctrl+F3'],
        ['Anchored VP & TPO'],
        ['ZigZag VP & TPO'],
        ['Anchored VWAP', 'F4'],
        ['Dynamic POC'],
        ['CVD correlation'],
      ],
    },
    {
      id: 'fib',
      label: 'Fibonacci',
      icon: Spline,
      items: [['Retracements', 'F8'], ['Extensions'], ['Fibo Fan'], ['Time Zones'], ['Arcs']],
    },
    {
      id: 'measure',
      label: 'Measurement',
      icon: PencilRuler,
      items: [['Ruler', 'F9'], ['Measure']],
    },
    {
      id: 'elliott',
      label: 'Elliott Waves',
      icon: Waves,
      items: [
        ['Impulse (12345)'],
        ['Correction (ABC)'],
        ['Triangle (ABCDE)'],
        ['Double Combo (WXY)'],
        ['Triple Combo (WXYXZ)'],
      ],
    },
    {
      id: 'markers',
      label: 'Chart Markers',
      icon: Circle,
      items: [
        ['Dot', 'Ctrl+Shift+N'],
        ['Diamond', 'Ctrl+Shift+Q'],
        ['Square', 'Ctrl+Shift+E'],
        ['Up Arrow', 'Ctrl+Shift+W'],
        ['Down Arrow', 'Ctrl+Shift+S'],
      ],
    },
    {
      id: 'text',
      label: 'Text',
      icon: Type,
      items: [
        ['Text', 'Ctrl+Shift+T'],
        ['Label', 'Ctrl+Shift+L'],
        ['Right Price Label', 'Ctrl+Shift+D'],
        ['Left Price Label', 'Ctrl+Shift+A'],
      ],
    },
    {
      id: 'positions',
      label: 'Positions',
      icon: ArrowUpRight,
      items: [['Long Position'], ['Short Position']],
    },
    {
      id: 'gann',
      label: 'Gann & Pitchfork',
      icon: Gauge,
      items: [['Gann Fan'], ['Gann Grid'], ["Andrew's Pitchfork"]],
    },
    {
      id: 'objects',
      label: 'Objects',
      icon: List,
      items: [
        ['Objects List'],
        ['Keep Drawing'],
        ['Delete selected', 'Del'],
        ['Delete all'],
        ['Remove indicators'],
      ],
    },
  ];

export function SideTools({
  mode,
  onMode,
  showFootprint,
  onSettings,
  compact,
}: {
  mode: string;
  onMode: (id: string) => void;
  showFootprint: boolean;
  onSettings: () => void;
  compact: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = footprintMode(mode).group;
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
            aria-label={g.label}
            title={g.label}
            onClick={() => setOpen(open === g.id ? null : g.id)}
          >
            <g.icon size={15} />
            <ChevronRight size={7} className="st-chev" />
          </button>
          {open === g.id && (
            <div className="st-flyout" role="menu" aria-label={g.label}>
              <div className="ht-menu-label">{g.label}</div>
              {g.items.map(([label, sc]) => (
                <button
                  key={label}
                  className="st-item"
                  disabled
                  title="Drawing tools ship in phase P12"
                >
                  <span className="st-check" />
                  {label}
                  {sc && <span className="ht-menu-sc">{sc}</span>}
                </button>
              ))}
              <div className="st-note">Drawing tools arrive in P12</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
