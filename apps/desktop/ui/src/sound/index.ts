/**
 * Sounds (P43). Built-in sounds are synthesized with WebAudio (no audio files ship with the app);
 * user sounds are data URLs stored in the encrypted settings. Other modules call `playSound(event)`.
 */
import { getSetting } from '../state/settings';
import { BUILTIN_SOUNDS, type BuiltinSound, type SoundEvent } from './events';

export * from './events';

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** [frequency Hz, start s, duration s, waveform] notes per built-in sound. */
const VOICES: Record<BuiltinSound, [number, number, number, OscillatorType][]> = {
  chime: [
    [880, 0, 0.18, 'sine'],
    [1320, 0.09, 0.3, 'sine'],
  ],
  ding: [[1568, 0, 0.45, 'sine']],
  pop: [[620, 0, 0.06, 'triangle']],
  blip: [
    [1200, 0, 0.05, 'square'],
    [1600, 0.06, 0.05, 'square'],
  ],
  buzz: [
    [150, 0, 0.18, 'sawtooth'],
    [150, 0.22, 0.18, 'sawtooth'],
  ],
  alarm: [
    [990, 0, 0.14, 'square'],
    [740, 0.16, 0.14, 'square'],
    [990, 0.32, 0.14, 'square'],
    [740, 0.48, 0.14, 'square'],
  ],
  bell: [
    [1046, 0, 0.6, 'sine'],
    [2093, 0, 0.35, 'sine'],
  ],
  tick: [[2400, 0, 0.02, 'square']],
};

function synth(id: BuiltinSound, gain: number): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  for (const [f, start, dur, type] of VOICES[id]) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.value = f;
    const peak = gain * (type === 'sine' ? 0.5 : 0.18);
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

/** Plays a sound reference ("chime" or "custom:<id>") at 0..1 volume. Never throws. */
export function playSoundRef(ref: string, volume: number): void {
  const v = Math.max(0, Math.min(1, volume));
  if (v <= 0) return;
  try {
    if (ref.startsWith('custom:')) {
      const s = getSetting('sounds.custom').find((x) => 'custom:' + x.id === ref);
      if (!s) return synth('ding', v);
      const a = new Audio(s.dataUrl);
      a.volume = v;
      void a.play().catch(() => {});
      return;
    }
    synth(BUILTIN_SOUNDS.some((b) => b.id === ref) ? (ref as BuiltinSound) : 'ding', v);
  } catch {
    /* audio is best effort */
  }
}

const lastPlayed = new Map<SoundEvent, number>();

/** Plays the sound configured for an event (respects mute, master volume and per-event on/off). */
export function playSound(event: SoundEvent): void {
  if (getSetting('sounds.muteAll')) return;
  const cfg = getSetting('sounds.events')[event];
  if (!cfg?.enabled) return;
  const now = Date.now();
  if (now - (lastPlayed.get(event) ?? 0) < 120) return; // bursts of fills → one sound
  lastPlayed.set(event, now);
  playSoundRef(cfg.sound, (cfg.volume / 100) * (getSetting('sounds.master') / 100));
}
