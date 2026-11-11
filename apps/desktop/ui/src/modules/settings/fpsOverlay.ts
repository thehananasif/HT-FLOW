import { getSetting, onSettingChange } from '../../state/settings';

/** Settings → Performance → Show debug info: FPS / worst frame / JS heap overlay. */
export function installFpsOverlay(): void {
  if (typeof document === 'undefined') return;
  let el: HTMLDivElement | null = null;
  let raf = 0;
  const show = () => {
    if (el) return;
    const box = document.createElement('div');
    box.className = 'st-fps tnum';
    box.dataset.testid = 'fps-overlay';
    document.body.appendChild(box);
    el = box;
    let frames = 0;
    let t0 = performance.now();
    let last = t0;
    let worst = 0;
    const tick = (t: number) => {
      frames++;
      worst = Math.max(worst, t - last);
      last = t;
      if (t - t0 >= 500) {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        box.textContent =
          `${((frames * 1000) / (t - t0)).toFixed(0)} FPS · max ${worst.toFixed(1)} ms` +
          (mem ? ` · ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '');
        frames = 0;
        worst = 0;
        t0 = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  const hide = () => {
    cancelAnimationFrame(raf);
    el?.remove();
    el = null;
  };
  const sync = (on: boolean) => (on ? show() : hide());
  onSettingChange('performance.showDebugInfo', sync);
  sync(getSetting('performance.showDebugInfo'));
}
