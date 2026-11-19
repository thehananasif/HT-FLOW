import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  panelWidthOf,
  panelWidthStore,
  setPanelWidth,
} from './panelWidth';

/**
 * Drag handle on the left edge of a right-docked panel. Dragging left widens the panel; the width
 * is saved per panel id and double-click (or Home) restores the default. Arrow keys nudge by 16 px.
 */
export function PanelResizeHandle({ panelId }: { panelId: string }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const current = () => panelWidthOf(panelWidthStore.get(), panelId);
  const apply = (w: number) =>
    setPanelWidth(
      panelId,
      clampPanelWidth(w, typeof window === 'undefined' ? 1600 : window.innerWidth),
    );

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: current() };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) apply(drag.current.w + (drag.current.x - e.clientX));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') apply(current() + 16);
    else if (e.key === 'ArrowRight') apply(current() - 16);
    else if (e.key === 'Home' || e.key === 'Enter') setPanelWidth(panelId, null);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="panel-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={current()}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      tabIndex={0}
      title={`Drag to resize · double-click to reset (${PANEL_DEFAULT_WIDTH}px)`}
      data-testid={`${panelId}-resize`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setPanelWidth(panelId, null)}
      onKeyDown={onKey}
    />
  );
}
