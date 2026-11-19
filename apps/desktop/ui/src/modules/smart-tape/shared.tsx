import { DropdownMenu, MenuTrigger, type MenuEntry } from '@htflow/ui-kit';
import { t, translateLiteral as tl } from '@htflow/i18n';
import { useWindows } from '../../state/windows';
import { DEFAULT_INSTRUMENT, allInstruments, instrumentById } from '../../state/instruments';
import { isTauri } from '../../backend';
import { fmtClock } from '../../state/format';
import { getSetting } from '../../state/settings';

/* Shared helpers for the tape / analytics module windows (smart-tape, bidask-tape, all-prices,
 * market-pressure, price-change, dom-pressure, delta-divergence). */

// The last chart / DOM window the user activated. Module windows (tapes, scanners) become active
// when clicked, so "the active window" for following means the last non-module one.
let lastMarketWindow: string | null = null;
useWindows.subscribe((s) => {
  const w = s.activeId ? s.windows[s.activeId] : undefined;
  if (w && w.kind !== 'module') lastMarketWindow = s.activeId;
});

type WinState = ReturnType<typeof useWindows.getState>;

export function followTargetId(s: WinState = useWindows.getState()): string | null {
  if (lastMarketWindow && s.windows[lastMarketWindow]) return lastMarketWindow;
  return Object.keys(s.windows).find((k) => s.windows[k]!.kind !== 'module') ?? null;
}

/** Chart window that scanner row clicks retarget: the last active chart, else the first chart. */
export function chartTargetId(s: WinState = useWindows.getState()): string | null {
  if (lastMarketWindow && s.windows[lastMarketWindow]?.kind === 'chart') return lastMarketWindow;
  return Object.keys(s.windows).find((k) => s.windows[k]!.kind === 'chart') ?? null;
}

/** Instrument of the followed window, or the fixed one when the user picked an instrument. */
export function useFollowedInstrument(fixed: string | null | undefined): string {
  const followed = useWindows((s) => {
    const id = followTargetId(s);
    const w = id ? s.windows[id] : undefined;
    return w && w.kind !== 'module' ? w.instrumentId : null;
  });
  return (fixed && instrumentById(fixed) ? fixed : null) ?? followed ?? DEFAULT_INSTRUMENT;
}

export function InstrumentPicker({
  fixed,
  current,
  onChange,
}: {
  fixed: string | null;
  current: string;
  onChange: (id: string | null) => void;
}) {
  const items: MenuEntry[] = [
    {
      id: 'follow',
      label: t('tape.followActive'),
      checked: !fixed,
      onSelect: () => onChange(null),
    },
    { kind: 'separator', id: 's' },
    ...allInstruments(isTauri).map((i) => ({
      id: i.id,
      label: `${i.symbol} · ${i.exchange}`,
      checked: fixed === i.id,
      onSelect: () => onChange(i.id),
    })),
  ];
  return (
    <DropdownMenu
      items={items}
      trigger={
        <MenuTrigger data-testid="tape-instrument" title={tl('Instrument')}>
          {instrumentById(current)?.symbol ?? current}
          {!fixed && <span className="tape-follow">{t('tape.follow')}</span>}
        </MenuTrigger>
      }
    />
  );
}

/** Trade time in the application time zone / clock format; milliseconds follow Settings → Tape. */
export function fmtTime(ts: number, ms = getSetting('tape.showMs')): string {
  return fmtClock(ts, { ms });
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

let audio: AudioContext | null = null;
let lastBeep = 0;

/** Short WebAudio beep (higher pitch for buys). Throttled to ~6 per second. */
export function beep(side: number): void {
  const now = performance.now();
  if (now - lastBeep < 160) return;
  lastBeep = now;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = side > 0 ? 880 : side < 0 ? 520 : 680;
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.13);
  } catch {
    // audio unavailable (no device / blocked) — the visual highlight still shows
  }
}

/** Unlocks audio from a user gesture (browsers block AudioContext until then). */
export function primeAudio(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    /* ignore */
  }
}

export const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

export const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
  opts.includes(v as T) ? (v as T) : d;
