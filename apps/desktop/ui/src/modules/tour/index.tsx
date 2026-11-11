import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { log } from '../../state/log';
import { registerCommands } from '../../shell/commands';
import { placeTooltip, spotlightBox, TOUR_STEPS, type Box, type Placement } from './steps';
import './styles.css';

/**
 * First-run guided tour (P28): a spotlight + tooltip over the ribbon, chart, DOM, Trading Panel
 * and status bar. Shown once per user (flag saved with the profile), restartable from the
 * command palette. It mounts its own React root, so no shared file needs to know about it.
 */
const DONE_KEY = 'tour.done';

interface TourState {
  active: boolean;
  step: number;
}

let tour: TourState = { active: false, step: 0 };
const listeners = new Set<() => void>();
const set = (next: TourState) => {
  tour = next;
  listeners.forEach((l) => l());
};

export function startTour(): void {
  set({ active: true, step: 0 });
  log.info('tour', 'Guided tour started');
}

function endTour(finished: boolean): void {
  if (!tour.active) return;
  set({ active: false, step: 0 });
  log.info('tour', finished ? 'Guided tour finished' : 'Guided tour skipped');
  void backend.saveSettings(DONE_KEY, { done: true, at: Date.now() }).catch(() => undefined);
}

registerCommands([
  {
    id: 'tour.start',
    label: 'Start guided tour',
    group: 'Platform',
    keywords: 'onboarding walkthrough help intro first run',
    run: startTour,
  },
]);

function findTarget(selectors: string[]): Box | null {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4)
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  return null;
}

function TourOverlay() {
  const t = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => tour,
  );
  const [target, setTarget] = useState<Box | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = TOUR_STEPS[t.step];

  // First run: once the dashboard is on screen and this profile has not seen the tour.
  // Browser automation (Playwright sets navigator.webdriver) never auto-starts it, because the
  // overlay would block clicks in unrelated tests; tests start it from the palette instead.
  useEffect(() => {
    let checked = false;
    const id = setInterval(() => {
      const dashboard = !!document.querySelector('.app-root .ribbon');
      if (!dashboard) {
        checked = false;
        return;
      }
      if (checked || tour.active) return;
      checked = true;
      if (navigator.webdriver) return;
      void backend
        .loadSettings<{ done?: boolean }>(DONE_KEY)
        .then((v) => {
          if (!v?.done) setTimeout(() => !tour.active && startTour(), 800);
        })
        .catch(() => undefined);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Track the target (layout can change under the tour).
  useEffect(() => {
    if (!t.active || !step) return;
    const measure = () => setTarget(findTarget(step.targets));
    measure();
    const id = setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [t.active, step]);

  useLayoutEffect(() => {
    if (!t.active || !card.current) return;
    const r = card.current.getBoundingClientRect();
    setPlace(
      placeTooltip(
        target,
        { width: r.width, height: r.height },
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [t.active, t.step, target]);

  useEffect(() => {
    if (!t.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endTour(false);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (t.step >= TOUR_STEPS.length - 1) endTour(true);
        else set({ active: true, step: t.step + 1 });
      } else if (e.key === 'ArrowLeft' && t.step > 0) set({ active: true, step: t.step - 1 });
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [t.active, t.step]);

  if (!t.active || !step) return null;
  const last = t.step === TOUR_STEPS.length - 1;
  const spot = target ? spotlightBox(target, window.innerWidth, window.innerHeight) : null;

  return (
    <div className="tour-root" data-testid="tour">
      {/* Blocks clicks on the app while the tour is open. */}
      <div className="tour-shield" onClick={(e) => e.stopPropagation()} />
      {spot ? (
        <div
          className="tour-spot"
          style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-label="Guided tour"
        aria-live="polite"
        style={{
          left: place?.left ?? 0,
          top: place?.top ?? 0,
          visibility: place ? 'visible' : 'hidden',
        }}
      >
        <div className="tour-count tnum">
          Step {t.step + 1} of {TOUR_STEPS.length}
        </div>
        <h3 className="tour-title" data-testid="tour-title">
          {step.title}
        </h3>
        <p className="tour-body">{step.body}</p>
        {!target && <p className="tour-note">This window is not open in the current layout.</p>}
        <div className="tour-actions">
          <Button size="sm" variant="ghost" onClick={() => endTour(false)}>
            Skip tour
          </Button>
          <span className="grow" />
          {t.step > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => set({ active: true, step: t.step - 1 })}
            >
              Back
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={() => (last ? endTour(true) : set({ active: true, step: t.step + 1 }))}
          >
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('ht-tour-root')) {
  const host = document.createElement('div');
  host.id = 'ht-tour-root';
  document.body.appendChild(host);
  createRoot(host).render(<TourOverlay />);
}
