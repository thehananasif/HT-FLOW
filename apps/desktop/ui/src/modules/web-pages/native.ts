/**
 * Desktop bridge for Web Pages: one native window per panel (`webpage-<id>`), driven by the Rust
 * commands in `src-tauri/src/webpage_cmds.rs`. Only called when `isTauri`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeOpts {
  allow: string[];
  newWindowExternal: boolean;
  alwaysOnTop: boolean;
  bounds?: Bounds;
  title?: string;
}

export const nativePage = {
  open: (id: string, url: string, o: NativeOpts) =>
    invoke<void>('webpage_open', {
      args: {
        id,
        url,
        allow: o.allow,
        newWindowExternal: o.newWindowExternal,
        alwaysOnTop: o.alwaysOnTop,
        bounds: o.bounds,
        title: o.title,
      },
    }),
  navigate: (id: string, url: string) => invoke<void>('webpage_navigate', { id, url }),
  back: (id: string) => invoke<void>('webpage_back', { id }),
  forward: (id: string) => invoke<void>('webpage_forward', { id }),
  reload: (id: string) => invoke<void>('webpage_reload', { id }),
  close: (id: string) => invoke<void>('webpage_close', { id }),
  setBounds: (id: string, bounds: Bounds) => invoke<void>('webpage_set_bounds', { id, bounds }),
  setAlwaysOnTop: (id: string, onTop: boolean) =>
    invoke<void>('webpage_set_always_on_top', { id, onTop }),
  setPolicy: (id: string, allow: string[], newWindowExternal: boolean) =>
    invoke<string[]>('webpage_set_policy', { id, allow, newWindowExternal }),
  openExternal: (url: string) => invoke<void>('webpage_open_external', { url }),
};

export interface NativeEvents {
  navigated(url: string): void;
  bounds(b: Bounds): void;
  closed(): void;
}

/** Subscribes to events of one panel's window; returns the unsubscribe function. */
export async function listenNative(id: string, h: NativeEvents): Promise<() => void> {
  const offs: UnlistenFn[] = [];
  offs.push(
    await listen<{ id: string; url: string }>('webpage://navigated', (e) => {
      if (e.payload.id === id) h.navigated(e.payload.url);
    }),
    await listen<{ id: string } & Bounds>('webpage://bounds', (e) => {
      if (e.payload.id === id) {
        const { x, y, w, h: hh } = e.payload;
        h.bounds({ x, y, w, h: hh });
      }
    }),
    await listen<{ id: string }>('webpage://closed', (e) => {
      if (e.payload.id === id) h.closed();
    }),
  );
  return () => offs.forEach((o) => o());
}
