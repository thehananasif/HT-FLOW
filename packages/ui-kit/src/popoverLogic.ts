export type PopoverSide = 'top' | 'bottom' | 'left' | 'right';
export type PopoverAlign = 'start' | 'center' | 'end';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverPosition {
  x: number;
  y: number;
  /** The side actually used (after flipping). */
  side: PopoverSide;
}

const OPPOSITE: Record<PopoverSide, PopoverSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Viewport-relative position of a popover next to an anchor: placed on `side` when it fits,
 * flipped to the opposite side when it does not and the opposite has more room, then shifted
 * along the cross axis so it stays `padding` px inside the viewport.
 */
export function computePopover(opts: {
  anchor: Box;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  side?: PopoverSide;
  align?: PopoverAlign;
  offset?: number;
  padding?: number;
}): PopoverPosition {
  const { anchor: a, size, viewport } = opts;
  const offset = opts.offset ?? 4;
  const pad = opts.padding ?? 8;
  const align = opts.align ?? 'start';
  let side = opts.side ?? 'bottom';
  const vertical = side === 'top' || side === 'bottom';

  const room = (s: PopoverSide) =>
    s === 'bottom'
      ? viewport.height - (a.top + a.height) - offset - pad
      : s === 'top'
        ? a.top - offset - pad
        : s === 'right'
          ? viewport.width - (a.left + a.width) - offset - pad
          : a.left - offset - pad;
  const need = vertical ? size.height : size.width;
  if (room(side) < need && room(OPPOSITE[side]) > room(side)) side = OPPOSITE[side];

  let x: number;
  let y: number;
  if (vertical) {
    y = side === 'bottom' ? a.top + a.height + offset : a.top - offset - size.height;
    x =
      align === 'start'
        ? a.left
        : align === 'end'
          ? a.left + a.width - size.width
          : a.left + a.width / 2 - size.width / 2;
  } else {
    x = side === 'right' ? a.left + a.width + offset : a.left - offset - size.width;
    y =
      align === 'start'
        ? a.top
        : align === 'end'
          ? a.top + a.height - size.height
          : a.top + a.height / 2 - size.height / 2;
  }
  // Shift: keep inside the viewport on both axes (the main axis only matters when nothing fits).
  const clamp = (v: number, size_: number, vp: number) =>
    Math.max(pad, Math.min(v, vp - size_ - pad));
  x = clamp(x, size.width, viewport.width);
  y = clamp(y, size.height, viewport.height);
  return { x: Math.round(x), y: Math.round(y), side };
}
