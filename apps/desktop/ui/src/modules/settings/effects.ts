/**
 * Applies settings to the running app: theme + tokens, UI scale / font size, ribbon mode,
 * notifications (position, show, duration, max), layout direction (RTL flag), hotkey overrides,
 * paper-engine commissions, sound triggers, log capture and clear-on-logout.
 */
import { applyTheme, configureToasts, type ThemeName, type ThemeTokens } from '@htflow/ui-kit';
import type { Trade } from '@htflow/market-data';
import { setHotkeyOverrides } from '../../shell/commands';
import {
  RTL_LANGUAGES,
  getSetting,
  getSettings,
  useSettingsStore,
  type SettingsValues,
} from '../../state/settings';
import { useSession } from '../../state/session';
import { installLogCapture, logBuffer, type LogLevel } from '../../state/log';
import { hub, paper } from '../../state/market';
import { instrumentById } from '../../state/instruments';
import { playSound } from '../../sound';
import { engineFields, resolveCommission } from './model';

export type AppearanceValues = Pick<
  SettingsValues,
  | 'appearance.theme'
  | 'appearance.tokens'
  | 'appearance.uiScale'
  | 'appearance.fontSize'
  | 'appearance.ribbonIconsOnly'
>;

/** Applies (or live-previews) the appearance settings. */
export function applyAppearance(v: AppearanceValues): void {
  applyTheme(v['appearance.theme'] as ThemeName, v['appearance.tokens'] as Partial<ThemeTokens>);
  if (typeof document === 'undefined') return;
  const root = document.getElementById('root');
  const scale = v['appearance.uiScale'];
  if (root) root.style.setProperty('zoom', scale === 100 ? '' : String(scale / 100));
  const fs = v['appearance.fontSize'];
  for (const el of [document.documentElement, document.body, root])
    if (el) el.style.fontSize = fs === 12 ? '' : `${fs}px`;
  document.documentElement.classList.toggle(
    'ht-ribbon-icons-only',
    v['appearance.ribbonIconsOnly'],
  );
}

/** Layout direction: the RTL flag, or the language when it is right-to-left. */
export function layoutDirection(v: Pick<SettingsValues, 'general.rtl' | 'general.language'>) {
  const rtl =
    v['general.rtl'] === 'rtl' ||
    (v['general.rtl'] === 'auto' && RTL_LANGUAGES.includes(v['general.language']));
  return rtl ? 'rtl' : 'ltr';
}

/** Deletes the session and Cache API data (Settings → Privacy → clear caches). */
export function clearLocalCaches(): void {
  try {
    sessionStorage.clear();
    void caches?.keys().then((ks) => ks.forEach((k) => void caches.delete(k)));
  } catch {
    /* storage or Cache API unavailable */
  }
}

function commissionFor(accountId: string, instrumentId: string) {
  const c = resolveCommission(
    getSetting('commission.rules'),
    {
      makerPct: getSetting('commission.cryptoMakerPct'),
      takerPct: getSetting('commission.cryptoTakerPct'),
      perContractRT: getSetting('commission.futuresRT'),
    },
    accountId,
    instrumentId,
  );
  const inst = hub.peek(instrumentId)?.instrument ?? instrumentById(instrumentId);
  return engineFields(c, (inst?.tickValue ?? 0) > 0);
}

function applyCommission(accountId: string, instrumentId: string): void {
  const acc = paper.accounts.get(accountId);
  if (!acc) return;
  const f = commissionFor(accountId, instrumentId);
  acc.commissionPerUnit = f.commissionPerUnit;
  acc.takerFee = f.takerFee;
}

let installed = false;

export function installSettingsEffects(): void {
  if (installed) return;
  installed = true;
  const apply = (v: SettingsValues, prev?: SettingsValues) => {
    const changed = (k: keyof SettingsValues) => !prev || v[k] !== prev[k];
    if (
      changed('appearance.theme') ||
      changed('appearance.tokens') ||
      changed('appearance.uiScale') ||
      changed('appearance.fontSize') ||
      changed('appearance.ribbonIconsOnly')
    )
      applyAppearance(v);
    if (changed('hotkeys.bindings')) setHotkeyOverrides(v['hotkeys.bindings']);
    if (changed('common.notifyPosition') && typeof document !== 'undefined')
      document.documentElement.dataset.toastPos = v['common.notifyPosition'];
    if (
      changed('common.notifyShow') ||
      changed('common.notifyDurationMs') ||
      changed('common.notifyMax')
    )
      configureToasts({
        show: v['common.notifyShow'],
        durationMs: v['common.notifyDurationMs'],
        max: v['common.notifyMax'],
      });
    if (
      (changed('general.rtl') || changed('general.language')) &&
      typeof document !== 'undefined'
    ) {
      const el = document.documentElement;
      el.dir = layoutDirection(v);
      el.lang = v['general.language'];
    }
    if (changed('logs.level') || changed('logs.bufferSize'))
      logBuffer.configure({
        minLevel: v['logs.level'] as LogLevel,
        capacity: v['logs.bufferSize'],
      });
  };
  installLogCapture();
  // Privacy: optionally drop caches when the user logs out.
  let wasIn = !!useSession.getState().session;
  useSession.subscribe((st) => {
    const isIn = !!st.session;
    if (wasIn && !isIn && getSetting('privacy.clearOnLogout')) clearLocalCaches();
    wasIn = isIn;
  });
  // Settings load after login (session.setSession applies the account theme first).
  useSettingsStore.subscribe((s, p) => {
    if (s.values !== p.values) apply(s.values, p.values);
  });
  apply(getSettings());

  // Commission: set the account's fee fields for the instrument right before any fill can happen
  // (order placement, and resting orders filled by the tape).
  paper.preTradeChecks.push((req) => applyCommission(req.accountId, req.instrumentId));
  const onTrade = paper.onTrade.bind(paper);
  paper.onTrade = (instrumentId: string, t: Trade) => {
    for (const id of paper.accounts.keys()) applyCommission(id, instrumentId);
    onTrade(instrumentId, t);
  };

  // Sounds for events this module can observe.
  paper.postFillHooks.push(() => playSound('orderFilled'));
  const seenRejected = new Set<string>();
  paper.subscribe(() => {
    for (const o of paper.orders.values())
      if (o.status === 'rejected' && !seenRejected.has(o.id)) {
        seenRejected.add(o.id);
        playSound('orderRejected');
      }
  });
  const lastState = new Map<string, string>();
  hub.onStore((store) => {
    store.subscribe(() => {
      const id = store.instrument.id;
      const st = store.status.state;
      const prev = lastState.get(id);
      lastState.set(id, st);
      if (prev === 'live' && (st === 'disconnected' || st === 'error')) playSound('connectionLost');
    });
  });
}
