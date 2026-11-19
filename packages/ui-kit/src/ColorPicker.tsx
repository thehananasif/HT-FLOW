import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Plus, X } from 'lucide-react';
import {
  hsvToRgb,
  parseColor,
  pushRecent,
  rgbToHsv,
  toHex,
  toRgbString,
  type Hsva,
} from './colorMath';
import { addStop, gradientCss, removeStop, updateStop, type GradientStop } from './gradient';

import { translateLiteral as tl, tt } from '@htflow/i18n';
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export interface ColorPanelProps {
  value: string;
  onChange: (hex: string) => void;
  /** Show the opacity slider (default true). When false the output is always opaque. */
  alpha?: boolean;
  /** Saved swatches; persisted by the host through `onSwatchesChange`. */
  swatches?: string[];
  onSwatchesChange?: (next: string[]) => void;
  /** Recent colours; if `onRecentChange` is omitted the panel keeps them in memory. */
  recent?: string[];
  onRecentChange?: (next: string[]) => void;
}

/** The picker body: SV square, hue, opacity, hex/rgb entry, saved swatches and recent colours. */
export function ColorPanel({
  value,
  onChange,
  alpha = true,
  swatches,
  onSwatchesChange,
  recent,
  onRecentChange,
}: ColorPanelProps) {
  const parsed = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [hsv, setHsv] = useState<Hsva>(() => rgbToHsv(parsed));
  const [text, setText] = useState(toHex(parsed));
  const [fmt, setFmt] = useState<'hex' | 'rgb'>('hex');
  const [localRecent, setLocalRecent] = useState<string[]>([]);
  const lastEmitted = useRef(value);
  const svRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const recents = recent ?? localRecent;
  const fmtText = useCallback(
    (h: Hsva, f: 'hex' | 'rgb') => (f === 'hex' ? toHex(hsvToRgb(h)) : toRgbString(hsvToRgb(h))),
    [],
  );

  // Sync from outside (but keep our hue when the colour is grey/black and hue is undefined).
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const p = parseColor(value);
    if (!p) return;
    const next = rgbToHsv(p);
    setHsv((cur) => (next.s === 0 || next.v === 0 ? { ...next, h: cur.h } : next));
    setText(fmtText(next, fmt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (h: Hsva) => {
    const a = alpha ? h.a : 1;
    const next = { ...h, a };
    setHsv(next);
    const hex = toHex(hsvToRgb(next));
    lastEmitted.current = hex;
    setText(fmtText(next, fmt));
    onChange(hex);
  };

  const commitRecent = () => {
    const next = pushRecent(recents, toHex(hsvToRgb(hsv)));
    if (onRecentChange) onRecentChange(next);
    else setLocalRecent(next);
  };

  const svFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = svRef.current!.getBoundingClientRect();
    emit({
      ...hsv,
      s: clamp01((e.clientX - r.left) / r.width),
      v: clamp01(1 - (e.clientY - r.top) / r.height),
    });
  };
  const svKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    emit({ ...hsv, s: clamp01(hsv.s + m[0]), v: clamp01(hsv.v + m[1]) });
  };

  const applyText = () => {
    const p = parseColor(text);
    if (!p) {
      setText(fmtText(hsv, fmt));
      return;
    }
    const next = rgbToHsv(alpha ? p : { ...p, a: 1 });
    emit(next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next);
  };

  const current = toHex(hsvToRgb(hsv));
  const rgb = hsvToRgb(hsv);
  const opaque = toHex({ ...rgb, a: 1 });
  const saved = swatches ?? [];

  return (
    <div className="ht-colorpanel" data-testid="color-panel">
      <div
        ref={svRef}
        className="ht-cp-sv"
        style={{ background: `hsl(${hsv.h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label={tl('Saturation and brightness')}
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        aria-valuenow={Math.round(hsv.s * 100)}
        onKeyDown={svKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          svFromPointer(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && svFromPointer(e)}
        onPointerUp={commitRecent}
      >
        <div className="ht-cp-sv-white" />
        <div className="ht-cp-sv-black" />
        <span
          className="ht-cp-thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }}
        />
      </div>
      <input
        type="range"
        className="ht-cp-hue"
        aria-label={tl('Hue')}
        min={0}
        max={360}
        value={Math.round(hsv.h)}
        onChange={(e) => emit({ ...hsv, h: Number(e.target.value) })}
        onPointerUp={commitRecent}
      />
      {alpha && (
        <div className="ht-cp-alpha-row">
          <input
            type="range"
            className="ht-cp-alpha"
            aria-label={tl('Opacity')}
            min={0}
            max={100}
            value={Math.round(hsv.a * 100)}
            style={{
              backgroundImage: `linear-gradient(90deg, transparent, ${opaque}), var(--ht-checker)`,
            }}
            onChange={(e) => emit({ ...hsv, a: Number(e.target.value) / 100 })}
            onPointerUp={commitRecent}
          />
          <span className="tnum ht-cp-pct">{Math.round(hsv.a * 100)}%</span>
        </div>
      )}
      <div className="ht-cp-entry">
        <span className="ht-cp-preview" aria-hidden>
          <span style={{ background: current }} />
        </span>
        <input
          className="ht-input mono"
          aria-label={fmt === 'hex' ? 'Hex colour' : 'RGB colour'}
          id={`${id}-text`}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={applyText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              applyText();
              commitRecent();
            }
          }}
        />
        <button
          type="button"
          className="ht-btn ht-btn--xs"
          aria-label={tl('Toggle hex or RGB entry')}
          onClick={() => {
            const f = fmt === 'hex' ? 'rgb' : 'hex';
            setFmt(f);
            setText(fmtText(hsv, f));
          }}
        >
          {fmt === 'hex' ? 'HEX' : 'RGB'}
        </button>
      </div>
      {onSwatchesChange && (
        <SwatchRow
          title={tl('Saved')}
          colors={saved}
          onPick={(c) => {
            const p = parseColor(c);
            if (p) emit(rgbToHsv(alpha ? p : { ...p, a: 1 }));
          }}
          onRemove={(c) => onSwatchesChange(saved.filter((x) => x !== c))}
          onAdd={() => {
            if (!saved.includes(current)) onSwatchesChange([...saved, current].slice(-24));
          }}
        />
      )}
      {recents.length > 0 && (
        <SwatchRow
          title={tl('Recent')}
          colors={recents}
          onPick={(c) => {
            const p = parseColor(c);
            if (p) emit(rgbToHsv(alpha ? p : { ...p, a: 1 }));
          }}
        />
      )}
    </div>
  );
}

function SwatchRow({
  title,
  colors,
  onPick,
  onRemove,
  onAdd,
}: {
  title: string;
  colors: string[];
  onPick: (c: string) => void;
  onRemove?: (c: string) => void;
  onAdd?: () => void;
}) {
  return (
    <div className="ht-cp-swatches" role="group" aria-label={tt`${title} colours`}>
      <span className="ht-cp-swatches-title">{title}</span>
      <div className="ht-cp-swatch-grid">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            className="ht-cp-swatch"
            style={{ ['--sw' as string]: c }}
            aria-label={`${title} ${c}${onRemove ? ' (Delete to remove)' : ''}`}
            title={c}
            onClick={() => onPick(c)}
            onContextMenu={(e) => {
              if (!onRemove) return;
              e.preventDefault();
              onRemove(c);
            }}
            onKeyDown={(e) => {
              if (onRemove && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault();
                onRemove(c);
              }
            }}
          />
        ))}
        {onAdd && (
          <button
            type="button"
            className="ht-cp-swatch ht-cp-swatch--add"
            aria-label={tl('Save current colour')}
            title={tl('Save current colour')}
            onClick={onAdd}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export interface ColorPickerProps extends ColorPanelProps {
  label: string;
  className?: string;
}

/**
 * ColorPicker v2. Same `{ value, onChange, label }` core as ColorSwatch, plus opacity,
 * hex/rgb entry, saved swatches (persist via `onSwatchesChange`) and recent colours.
 */
export function ColorPicker({ label, className, ...panel }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open]);
  const c = parseColor(panel.value);
  return (
    <div
      ref={root}
      className={cx('ht-colorpicker', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }
      }}
    >
      <button
        ref={btn}
        type="button"
        className="ht-cp-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ht-cp-preview" aria-hidden>
          <span style={{ background: panel.value }} />
        </span>
        <span className="mono ht-cp-trigger-text">
          {(c ? toHex(c) : panel.value).toUpperCase()}
        </span>
      </button>
      {open && (
        <div className="ht-cp-pop" role="dialog" aria-label={tt`${label} picker`}>
          <ColorPanel {...panel} />
        </div>
      )}
    </div>
  );
}

/* ---------- Gradient editor ---------- */

export interface GradientEditorProps {
  stops: GradientStop[];
  onChange: (stops: GradientStop[]) => void;
  label?: string;
  swatches?: string[];
  onSwatchesChange?: (next: string[]) => void;
}

/** Multi-stop gradient editor (heatmap colour ramps). Click the bar to add a stop. */
export function GradientEditor({
  stops,
  onChange,
  label = 'Gradient',
  swatches,
  onSwatchesChange,
}: GradientEditorProps) {
  const [sel, setSel] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const idx = Math.min(sel, stops.length - 1);
  const posFromPointer = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };
  return (
    <div className="ht-grad" role="group" aria-label={label}>
      <div
        ref={bar}
        className="ht-grad-bar"
        style={{ backgroundImage: `${gradientCss(stops, 90)}, var(--ht-checker)` }}
        onDoubleClick={(e) => {
          const next = addStop(stops, posFromPointer(e.clientX));
          onChange(next);
          setSel(next.findIndex((s) => Math.abs(s.pos - posFromPointer(e.clientX)) < 1e-6));
        }}
      >
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className="ht-grad-stop"
            data-selected={i === idx || undefined}
            style={{ left: `${s.pos * 100}%`, ['--sw' as string]: s.color }}
            aria-label={tt`Stop ${i + 1} at ${Math.round(s.pos * 100)}%`}
            onClick={() => setSel(i)}
            onPointerDown={(e) => {
              setSel(i);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1)
                onChange(updateStop(stops, i, { pos: posFromPointer(e.clientX) }));
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.01;
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                onChange(
                  updateStop(stops, i, { pos: s.pos + (e.key === 'ArrowLeft' ? -step : step) }),
                );
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                onChange(removeStop(stops, i));
              }
            }}
          />
        ))}
      </div>
      <div className="ht-grad-rows">
        {stops.map((s, i) => (
          <div key={i} className="ht-grad-row" data-selected={i === idx || undefined}>
            <ColorPicker
              label={tt`Stop ${i + 1} colour`}
              value={s.color}
              onChange={(c) => onChange(updateStop(stops, i, { color: c }))}
              swatches={swatches}
              onSwatchesChange={onSwatchesChange}
            />
            <input
              className="ht-input tnum ht-grad-pos"
              type="number"
              min={0}
              max={100}
              step={1}
              aria-label={tt`Stop ${i + 1} position %`}
              value={Math.round(s.pos * 100)}
              onFocus={() => setSel(i)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange(updateStop(stops, i, { pos: n / 100 }));
              }}
            />
            <button
              type="button"
              className="ht-icon-btn"
              aria-label={tt`Remove stop ${i + 1}`}
              disabled={stops.length <= 2}
              onClick={() => onChange(removeStop(stops, i))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="ht-btn ht-btn--sm"
        onClick={() => {
          // Add in the widest gap.
          const sorted = [...stops].sort((a, b) => a.pos - b.pos);
          let best = 0;
          let at = 0.5;
          for (let i = 1; i < sorted.length; i++) {
            const g = sorted[i]!.pos - sorted[i - 1]!.pos;
            if (g > best) {
              best = g;
              at = (sorted[i]!.pos + sorted[i - 1]!.pos) / 2;
            }
          }
          const next = addStop(stops, at);
          onChange(next);
          setSel(next.findIndex((s) => s.pos === at));
        }}
      >
        <Plus size={12} /> {tl('Add stop')}
      </button>
    </div>
  );
}
