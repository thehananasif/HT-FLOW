/** Sound events (P43 Sounds settings) and the built-in synthesized sounds. Pure data. */

export type SoundEvent =
  | 'orderFilled'
  | 'orderRejected'
  | 'alert'
  | 'bigTrade'
  | 'connectionLost'
  | 'riskLimit'
  | 'economicEvent';

export type BuiltinSound = 'chime' | 'ding' | 'pop' | 'blip' | 'buzz' | 'alarm' | 'bell' | 'tick';

export interface SoundEventDef {
  id: SoundEvent;
  label: string;
  help: string;
  sound: BuiltinSound;
  volume: number;
}

export const SOUND_EVENTS: SoundEventDef[] = [
  {
    id: 'orderFilled',
    label: 'Order filled',
    help: 'Any fill on a paper, replay or broker account (partial fills included).',
    sound: 'chime',
    volume: 70,
  },
  {
    id: 'orderRejected',
    label: 'Order rejected',
    help: 'An order was rejected by the risk checks, the paper engine or the broker.',
    sound: 'buzz',
    volume: 80,
  },
  {
    id: 'alert',
    label: 'Alert',
    help: 'A price / indicator / drawing alert fired (P23).',
    sound: 'bell',
    volume: 80,
  },
  {
    id: 'bigTrade',
    label: 'Big trade',
    help: 'A print above the big-trade filter on the tape (P16).',
    sound: 'pop',
    volume: 50,
  },
  {
    id: 'connectionLost',
    label: 'Connection lost',
    help: 'A live connection went from Live to Disconnected / Error.',
    sound: 'alarm',
    volume: 90,
  },
  {
    id: 'riskLimit',
    label: 'Risk limit',
    help: 'A daily loss / position risk limit was reached (P23 / P41).',
    sound: 'alarm',
    volume: 100,
  },
  {
    id: 'economicEvent',
    label: 'Economic event',
    help: 'An economic calendar event is about to be released (P39).',
    sound: 'ding',
    volume: 60,
  },
];

export const BUILTIN_SOUNDS: { id: BuiltinSound; label: string }[] = [
  { id: 'chime', label: 'Chime' },
  { id: 'ding', label: 'Ding' },
  { id: 'pop', label: 'Pop' },
  { id: 'blip', label: 'Blip' },
  { id: 'buzz', label: 'Buzz' },
  { id: 'alarm', label: 'Alarm' },
  { id: 'bell', label: 'Bell' },
  { id: 'tick', label: 'Tick' },
];

export interface SoundEventConfig {
  enabled: boolean;
  /** 0..100 */
  volume: number;
  /** A BuiltinSound id or "custom:<id>". */
  sound: string;
}

export interface CustomSound {
  id: string;
  name: string;
  /** data:audio/...;base64,… */
  dataUrl: string;
}

/** Custom sound files are stored in the encrypted settings blob; keep them small. */
export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_SOUNDS = 20;
