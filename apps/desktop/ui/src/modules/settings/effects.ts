/**
 * Applies settings to the running app: theme + tokens, UI scale / font size, ribbon mode,
 * notifications (position, show, duration, max), layout direction (RTL flag), hotkey overrides,
 * paper-engine commissions, sound triggers, log capture and clear-on-logout.
 */
import { isLocale, setLocale } from '@htflow/i18n';
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
import { isTauri } from '../../backend';
import { currentNativePrefs, nativeOpsAvailable, nativePrefsSet } from '../../platform/nativeOps';
import { dataApi } from '../data-manager/api';
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

/** Recorder limits from Settings → Common → Database & recorder (retention days, disk budget GB). */
export function recorderLimits(
  v: Pick<SettingsValues, 'common.recorderMaxGb' | 'common.tickRetentionDays'>,
): { retentionDays: number; maxDiskGb: number } {
  return {
    retentionDays: Math.max(1, Math.round(v['common.tickRetentionDays'])),
    maxDiskGb: Math.max(1, v['common.recorderMaxGb']),
  };
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
  const futures = (inst?.tickValue ?? 0) > 0;
  return { ...engineFields(c, futures), makerFee: futures ? 0 : c.makerPct / 100 };
}

function applyCommission(accountId: string, instrumentId: string): void {
  const acc = paper.accounts.get(accountId);
  if (!acc) return;
  const f = commissionFor(accountId, instrumentId);
  acc.commissionPerUnit = f.commissionPerUnit;
  acc.takerFee = f.takerFee;
  acc.makerFee = f.makerFee;
}

let lastNativePrefs = '';
/** Mirrors the start-up preferences to the core once logged in, and again whenever they change. */
function syncNativePrefs(): void {
  if (!nativeOpsAvailable() || !useSession.getState().session) return;
  const prefs = currentNativePrefs();
  const key = JSON.stringify(prefs);
  if (key === lastNativePrefs) return;
  lastNativePrefs = key;
  void nativePrefsSet(prefs).catch(() => {
    lastNativePrefs = '';
  });
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
      const lang = v['general.language'];
      setLocale(isLocale(lang) ? lang : 'en');
    }
    // Settings → Data → recorder: turns the native tick-store recorder on / off and applies its
    // disk budget / retention (desktop only; only on a change so the Data Manager's own toggle
    // and limits are not overridden at start-up).
    if (
      prev &&
      isTauri &&
      (changed('data.recorderEnabled') ||
        changed('common.recorderMaxGb') ||
        changed('common.tickRetentionDays'))
    ) {
      const lim = recorderLimits(v);
      void dataApi
        .status()
        .then((st) =>
          dataApi.setRecorder(
            v['data.recorderEnabled'],
            st.settings.instruments,
            lim.retentionDays,
            lim.maxDiskGb,
          ),
        )
        .catch(() => {});
    }
    // Settings → Data → cache size: caps the native history cache (also at start-up).
    if (changed('data.cacheSizeMb') && isTauri)
      void dataApi.setCacheSize(v['data.cacheSizeMb']).catch(() => {});
    syncNativePrefs();
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
    if (isIn) syncNativePrefs();
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
