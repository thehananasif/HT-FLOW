/** Window bus transport: one global Tauri event every window listens to (no-op in the web build). */
import { emit } from '@tauri-apps/api/event';
import { isTauri, onNative } from './native';
import { BUS_EVENT, parseBusMsg, type BusMsg } from './windowBus';

export function sendBus(msg: BusMsg): void {
  if (!isTauri) return;
  void emit(BUS_EVENT, msg).catch((e) => console.warn('window bus', e));
}

/** Valid messages only; the caller filters out its own (`from`). */
export function listenBus(fn: (m: BusMsg) => void): Promise<() => void> {
  return onNative<unknown>(BUS_EVENT, (raw) => {
    const m = parseBusMsg(raw);
    if (m) fn(m);
  });
}
