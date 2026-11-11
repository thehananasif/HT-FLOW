import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { clampRatio } from './splitLogic';

export interface SplitPaneProps {
  direction?: 'horizontal' | 'vertical';
  /** Initial ratio of the first pane (0-1). */
  defaultRatio?: number;
  minA?: number;
  minB?: number;
  /** Called on drag end / keyboard change so the host can persist the ratio. */
  onRatioChange?: (ratio: number) => void;
  children: [ReactNode, ReactNode];
  className?: string;
  'aria-label'?: string;
}

/** Two panes with a draggable, keyboard-operable (arrows, Home/End) divider. */
export function SplitPane({
  direction = 'horizontal',
  defaultRatio = 0.5,
  minA = 80,
  minB = 80,
  onRatioChange,
  children,
  className,
  'aria-label': ariaLabel = 'Resize panes',
}: SplitPaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(defaultRatio);
  const [total, setTotal] = useState(0);
  const horiz = direction === 'horizontal';
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTotal(horiz ? el.clientWidth : el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [horiz]);

  useEffect(() => setRatio(defaultRatio), [defaultRatio]);

  const eff = clampRatio(ratio, total, minA, minB);
  const commit = (r: number) => {
    const c = clampRatio(r, total, minA, minB);
    setRatio(c);
    return c;
  };
  const fromPointer = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return horiz ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height;
  };

  return (
    <div
      ref={ref}
      className={`ht-split ht-split--${direction} ${className ?? ''}`}
      style={{ ['--ht-split' as string]: `${eff * 100}%` }}
    >
      <div className="ht-split-a">{children[0]}</div>
      <div
        className="ht-split-handle"
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation={horiz ? 'vertical' : 'horizontal'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(eff * 100)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.dragging = 'true';
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) commit(fromPointer(e.clientX, e.clientY));
        }}
        onPointerUp={(e) => {
          delete e.currentTarget.dataset.dragging;
          onRatioChange?.(clampRatio(ratioRef.current, total, minA, minB));
        }}
        onDoubleClick={() => onRatioChange?.(commit(defaultRatio))}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          const dec = horiz ? 'ArrowLeft' : 'ArrowUp';
          const inc = horiz ? 'ArrowRight' : 'ArrowDown';
          let next: number | null = null;
          if (e.key === dec) next = eff - step;
          else if (e.key === inc) next = eff + step;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = 1;
          if (next == null) return;
          e.preventDefault();
          onRatioChange?.(commit(next));
        }}
      />
      <div className="ht-split-b">{children[1]}</div>
    </div>
  );
}
