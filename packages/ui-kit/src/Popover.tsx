import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  computePopover,
  type PopoverAlign,
  type PopoverPosition,
  type PopoverSide,
} from './popoverLogic';

export interface PopoverProps {
  /** The element the popover is anchored to (clicks on it do not count as "outside"). */
  trigger: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
  side?: PopoverSide;
  align?: PopoverAlign;
  offset?: number;
  /** Min distance to the viewport edge. */
  padding?: number;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  testId?: string;
}

/**
 * Anchored panel rendered through a portal on `document.body`, so it is never clipped by an
 * `overflow: hidden` ancestor. Positioned with fixed coordinates: flips to the opposite side when
 * it does not fit and shifts to stay inside the viewport. Esc and outside clicks close it.
 */
export function Popover({
  trigger,
  open,
  onOpenChange,
  children,
  side = 'bottom',
  align = 'start',
  offset = 4,
  padding = 8,
  className,
  style,
  'aria-label': ariaLabel,
  testId,
}: PopoverProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    const p = panel.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    setPos(
      computePopover({
        anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
        size: { width: p.offsetWidth, height: p.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
        offset,
        padding,
      }),
    );
  }, [side, align, offset, padding]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onMove);
    if (panel.current) ro?.observe(panel.current);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      ro?.disconnect();
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onOpenChange(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <span ref={anchor} className="ht-popover-anchor" style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={ariaLabel}
            className={`ht-popover ${className ?? ''}`}
            data-side={pos?.side}
            data-testid={testId}
            style={{
              ...style,
              left: pos?.x ?? 0,
              top: pos?.y ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
