import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCommands, registerPaletteProvider } from '../../shell/commands';
import {
  SECTIONS,
  getSetting,
  installSettingsSync,
  setSetting,
  type SectionId,
} from '../../state/settings';
import { registerModule, type ModuleViewProps } from '../registry';
import { installSettingsEffects } from './effects';
import { installFpsOverlay } from './fpsOverlay';
import { ConfirmHost } from './ConfirmHost';
import { settingsPaletteItems } from './palette';
import { SettingsView } from './SettingsView';
import './styles.css';

installSettingsSync();
installSettingsEffects();
installFpsOverlay();

// Confirmation dialogs (state/confirm.ts) render here, independent of any window.
if (typeof document !== 'undefined' && !document.getElementById('ht-confirm-host')) {
  const host = document.createElement('div');
  host.id = 'ht-confirm-host';
  document.body.appendChild(host);
  createRoot(host).render(<ConfirmHost />);
}

/** Section requested by the last "Settings: …" command (read when the window mounts). */
let pendingSection: SectionId | null = null;

function openSettings(section?: SectionId) {
  pendingSection = section ?? null;
  if (document.querySelector('[data-testid="settings-window"]')) {
    window.dispatchEvent(new CustomEvent('htflow:settings-section', { detail: section }));
    return;
  }
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'settings' }));
}

function SettingsWindow({ windowId, state, setParams }: ModuleViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SectionId>(
    () => pendingSection ?? (state.params?.section as SectionId | undefined) ?? 'general',
  );
  const [key, setKey] = useState(0);
  useEffect(() => {
    pendingSection = null;
    const on = (e: Event) => {
      const s = (e as CustomEvent).detail as SectionId | undefined;
      if (s) {
        setSection(s);
        setKey((k) => k + 1);
      }
    };
    window.addEventListener('htflow:settings-section', on);
    return () => window.removeEventListener('htflow:settings-section', on);
  }, []);
  useEffect(() => {
    if (state.params?.section !== section) setParams({ section });
  }, [section, state.params?.section, setParams]);
  return (
    <div className="module-window" ref={ref}>
      <SettingsView
        key={key}
        initialSection={section}
        onClose={() => {
          // The module view has no panel API: close through the window header's own button.
          const group = ref.current?.closest('.dv-groupview');
          const btn =
            group?.querySelector<HTMLButtonElement>(
              `[data-testid="win-hdr-${windowId}"] [aria-label="Close window"]`,
            ) ??
            group?.querySelector<HTMLButtonElement>('.dv-active-tab [aria-label="Close window"]');
          btn?.click();
        }}
      />
    </div>
  );
}

registerModule({ id: 'settings', label: 'Settings', view: SettingsWindow });

registerCommands([
  {
    id: 'settings.open',
    label: 'Settings',
    group: 'Platform',
    shortcut: 'Ctrl+,',
    keywords: 'preferences options configuration customize',
    run: () => openSettings(),
  },
  ...SECTIONS.map((s) => ({
    id: `settings.${s.id}`,
    label: `Settings: ${s.label}`,
    group: 'Platform' as const,
    keywords: 'preferences',
    run: () => openSettings(s.id),
  })),
  {
    id: 'language.en',
    label: 'Language: English',
    group: 'Platform',
    keywords: 'language locale english ltr زبان',
    run: () => void setSetting('general.language', 'en'),
  },
  {
    id: 'language.ur',
    label: 'Language: اردو',
    group: 'Platform',
    keywords: 'language locale urdu rtl right to left اردو زبان',
    run: () => void setSetting('general.language', 'ur'),
  },
  {
    id: 'sound.mute',
    label: 'Mute / unmute all sounds',
    group: 'Platform',
    run: () => void setSetting('sounds.muteAll', !getSetting('sounds.muteAll')),
  },
]);

// Command Palette rows: every settings section and key; each opens the Settings window at its section.
registerPaletteProvider(settingsPaletteItems);
