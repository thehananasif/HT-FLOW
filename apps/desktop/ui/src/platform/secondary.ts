/**
 * Separate OS windows — secondary-window side. A window opened with `?window=<label>` asks the
 * main window for its windows (`hello` → `init`), mirrors the main window's settings and paper
 * accounts, and sends back every local change (window states, layout, settings, trading actions).
 * It subscribes to market data itself (its own MarketHub), so charts and DOMs stay live without
 * forwarding every trade over IPC.
 */
import { create } from 'zustand';
import type { WindowState } from '@htflow/workspace';
import { backend, isTauri } from '../backend';
import { listenBus, sendBus } from './busTransport';
import {
  PAPER_METHODS,
  diffValues,
  diffWindows,
  initialSecondary,
  reduceSecondary,
  secondaryLabelFromSearch,
  type BusMsg,
  type PaperAccountSnap,
  type SecondaryState,
} from './windowBus';
import { MAIN_OWNED_KEYS } from './osWindows';
import { useWindows } from '../state/windows';
import { useSession } from '../state/session';
import { setSettings, settingsReady, useSettingsStore } from '../state/settings';
import { paper } from '../state/market';
import { reloadPersisted, setPersistedSaveHook } from '../trading/persist';

/** Label of this window when it is a secondary OS window, else null (the main window). */
export function secondaryLabel(): string | null {
  if (typeof window === 'undefined') return null;
  return secondaryLabelFromSearch(window.location.search);
}

export const useSecondary = create<SecondaryState>(() => initialSecondary(''));

let remote = 0;
/** Applies a change that came from the main window without sending it back. */
function fromMain(fn: () => void): void {
  remote++;
  try {
    fn();
  } finally {
    remote--;
  }
}

/** Mirrors the main window's paper accounts (the main window's engine is the only one). */
export function applyPaperSnapshot(accounts: PaperAccountSnap[]): void {
  const ids = new Set(accounts.map((a) => a.id));
  for (const a of [...paper.accounts.values()])
    if (a.kind === 'paper' && !ids.has(a.id)) paper.deleteAccount(a.id);
  for (const s of accounts) {
    if (!paper.accounts.has(s.id))
      paper.createAccount({
        id: s.id,
        name: s.name,
        currency: s.currency,
        startingBalance: s.startingBalance,
      });
    const a = paper.accounts.get(s.id)!;
    a.name = s.name;
    a.balance = s.balance;
    a.locked = s.locked;
    paper.importAccountState(s.id, s.state);
  }
}

/**
 * Trading actions in a secondary window run in the main window only: the local engine never
 * fills (no duplicate fills / brackets) and shows the main window's snapshots.
 */
function proxyPaper(label: string): void {
  const engine = paper as unknown as Record<string, unknown>;
  engine.onTrade = () => {};
  for (const m of PAPER_METHODS) {
    const original = engine[m] as (...a: unknown[]) => unknown;
    engine[m] = (...args: unknown[]) => {
      sendBus({ t: 'paper.call', from: label, method: m, args: JSON.parse(JSON.stringify(args)) });
      if (m === 'place') {
        const req = args[0] as Record<string, unknown>;
        const now = Date.now();
        // Placeholder until the main window's snapshot arrives with the real order.
        return {
          ...req,
          id: `remote-${now.toString(36)}`,
          filled: 0,
          tif: req.tif ?? 'GTC',
          reduceOnly: req.reduceOnly === true,
          status: 'working',
          avgFillPx: 0,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (m === 'tradeOption' || m === 'closeOption')
        return original.apply(paper, args) ?? 'Sent to the main window';
      return m === 'linkOco' ? null : m === 'cancelAll' ? 0 : true;
    };
  }
}

let started = false;

/** Starts the secondary-window runtime (once). */
export function startSecondary(label: string): void {
  if (started) return;
  started = true;
  useSecondary.setState(initialSecondary(label));
  proxyPaper(label);

  // The main window writes the shared stores; other stores save here and tell the others.
  const save = backend.saveSettings.bind(backend);
  (backend as { saveSettings: typeof backend.saveSettings }).saveSettings = async (key, value) => {
    if (MAIN_OWNED_KEYS.has(key)) return;
    await save(key, value);
  };
  setPersistedSaveHook((key) => sendBus({ t: 'store.saved', from: label, key }));

  let lastSent: Record<string, WindowState> = {};
  const onMsg = (m: BusMsg) => {
    const prev = useSecondary.getState();
    const next = reduceSecondary(prev, m);
    if (next !== prev) useSecondary.setState(next);
    if (m.from === label) return;
    switch (m.t) {
      case 'init':
        if (m.to !== label) return;
        fromMain(() => {
          lastSent = next.windows;
          useWindows.getState().setAll(next.windows);
          useSession.getState().setSession(m.session);
          applyPaperSnapshot(m.paper);
        });
        // The profile's settings load from disk; then the main window's live values win.
        void settingsReady().then(() =>
          fromMain(() => setSettings(m.settings as Parameters<typeof setSettings>[0])),
        );
        return;
      case 'windows':
        if (next.windows !== prev.windows)
          fromMain(() => {
            lastSent = next.windows;
            useWindows.setState({ windows: next.windows });
          });
        return;
      case 'settings':
        fromMain(() => setSettings(m.values as Parameters<typeof setSettings>[0]));
        return;
      case 'paper.state':
        fromMain(() => applyPaperSnapshot(m.accounts));
        return;
      case 'store.saved':
        if (!MAIN_OWNED_KEYS.has(m.key)) reloadPersisted(m.key);
        return;
      case 'close':
        if (m.to === label) closeSelf();
        return;
      default:
        return;
    }
  };
  void listenBus(onMsg);

  // Local window-state changes go to the main window (which applies link groups and saves).
  useWindows.subscribe((s) => {
    if (remote || useSecondary.getState().phase !== 'ready') return;
    const d = diffWindows(lastSent, s.windows);
    lastSent = s.windows;
    if (Object.keys(d.changed).length || d.removed.length)
      sendBus({ t: 'windows', from: label, windows: d.changed, removed: d.removed });
  });
  useSettingsStore.subscribe((s, p) => {
    if (remote || !s.loaded || !p.loaded || s.values === p.values) return;
    const values = diffValues(
      p.values as unknown as Record<string, unknown>,
      s.values as unknown as Record<string, unknown>,
    );
    if (Object.keys(values).length) sendBus({ t: 'settings', from: label, values });
  });

  // Ask until the main window answers (it may still be starting).
  let tries = 0;
  const hello = () => {
    if (useSecondary.getState().phase !== 'connecting' || tries++ > 60) return;
    sendBus({ t: 'hello', from: label });
    setTimeout(hello, 1000);
  };
  hello();
}

export function sendLayout(layout: unknown, title?: string): void {
  const s = useSecondary.getState();
  if (s.phase === 'ready') sendBus({ t: 'layout', from: s.label, layout, title });
}

/** Re-attach: the main window takes the windows back and closes this one. */
export function requestReattach(): void {
  const s = useSecondary.getState();
  if (isTauri && s.label) sendBus({ t: 'reattach', from: s.label });
  else closeSelf();
}

function closeSelf(): void {
  useSecondary.setState({ phase: 'closing' });
  backend.window.close();
}
