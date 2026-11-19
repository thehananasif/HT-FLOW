/**
 * Layout Settings window (P37 #4): header density and style, layout-tab position, snap to grid,
 * gap, where new windows open (per window type, docked / floating, size and placement), ribbon
 * mode, link-group colours, multi-monitor restore, lock layout and theme. Every value is a
 * `layout.*` setting, so it is validated, persisted per user and also editable in Settings → Layout.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  Button,
  ColorPicker,
  NumberInput,
  SegmentedControl,
  THEMES,
  type ThemeName,
} from '@htflow/ui-kit';
import { LINK_COLOR_DEFAULTS, LINK_COLORS, linkGroups, type LinkColor } from '@htflow/workspace';
import {
  getSetting,
  resetSection,
  setSetting,
  setSettings,
  settingDef,
  useSetting,
  type SettingKey,
  type SettingsValues,
} from '../../state/settings';
import { useWindows } from '../../state/windows';
import { registerCommands } from '../../shell/commands';
import { registerModule } from '../registry';
import { installLayoutEffects, LINK_SETTING } from './apply';
import { currentMonitors, installDisplayTracking, refreshDisplay } from './display';
import './styles.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
installLayoutEffects();

type EnumKey = {
  [K in SettingKey]: SettingsValues[K] extends string ? K : never;
}[SettingKey];

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="ls-row" title={help}>
      <span className="ls-label">{label}</span>
      <div className="ls-control">{children}</div>
    </div>
  );
}

/** Segmented control for an enum setting (disabled options are listed as a hint). */
function EnumRow({ k, label }: { k: EnumKey; label?: string }) {
  const value = useSetting(k) as string;
  const d = settingDef(k);
  if (d.type !== 'enum') return null;
  const off = d.options.filter((o) => o.disabled);
  return (
    <Row label={label ?? d.label} help={tl(d.help)}>
      <SegmentedControl<string>
        aria-label={tl(d.label)}
        value={value}
        onChange={(v) => setSetting(k, v as never)}
        options={d.options
          .filter((o) => !o.disabled)
          .map((o) => ({ value: o.value, label: o.label }))}
      />
      {off.length > 0 && (
        <span className="ls-hint">
          {off.map((o) => o.label.replace(/ — coming$/, '')).join(', ')}
          {tl(': coming')}
        </span>
      )}
    </Row>
  );
}

function BoolRow({
  k,
  on = 'On',
  offLabel = 'Off',
}: {
  k: SettingKey;
  on?: string;
  offLabel?: string;
}) {
  const value = useSetting(k) as boolean;
  const d = settingDef(k);
  return (
    <Row label={tl(d.label)} help={tl(d.help)}>
      <SegmentedControl<'on' | 'off'>
        aria-label={tl(d.label)}
        value={value ? 'on' : 'off'}
        onChange={(v) => setSetting(k, (v === 'on') as never)}
        options={[
          { value: 'on', label: on },
          { value: 'off', label: offLabel },
        ]}
      />
    </Row>
  );
}

function NumRow({ k }: { k: SettingKey }) {
  const value = useSetting(k) as number;
  const d = settingDef(k);
  if (d.type !== 'number') return null;
  return (
    <Row label={tl(d.label)} help={tl(d.help)}>
      <NumberInput
        aria-label={tl(d.label)}
        value={value}
        min={d.min}
        max={d.max}
        step={d.step}
        unit={d.unit}
        onChange={(v) => setSetting(k, v as never)}
      />
    </Row>
  );
}

function RibbonRow() {
  const icons = useSetting('appearance.ribbonIconsOnly');
  const hidden = useSetting('layout.ribbonHidden');
  const mode = hidden ? 'hidden' : icons ? 'icons' : 'labels';
  return (
    <Row
      label={tl('Ribbon')}
      help={tl('Icons with labels, icons only, or hidden (modules stay in Ctrl+K).')}
    >
      <SegmentedControl<'labels' | 'icons' | 'hidden'>
        aria-label={tl('Ribbon')}
        value={mode}
        onChange={(v) =>
          setSettings({
            'appearance.ribbonIconsOnly': v === 'icons',
            'layout.ribbonHidden': v === 'hidden',
          })
        }
        options={[
          { value: 'labels', label: 'Icons + labels' },
          { value: 'icons', label: 'Icons only' },
          { value: 'hidden', label: 'Hidden' },
        ]}
      />
    </Row>
  );
}

function ThemeRow() {
  const theme = useSetting('appearance.theme');
  const names = Object.keys(THEMES) as ThemeName[];
  return (
    <Row
      label={tl('Theme')}
      help={tl('Colour theme of the whole app (more in Settings → Appearance).')}
    >
      <SegmentedControl<ThemeName>
        aria-label={tl('Theme')}
        value={theme}
        onChange={(v) => setSetting('appearance.theme', v)}
        options={names.map((n) => ({
          value: n,
          label: n
            .split('-')
            .map((w) => w[0]!.toUpperCase() + w.slice(1))
            .join(' '),
        }))}
      />
    </Row>
  );
}

function LinkColorRow({ c }: { c: Exclude<LinkColor, 'none'> }) {
  const key = LINK_SETTING[c];
  const value = useSetting(key) as string;
  const windows = useWindows((s) => s.windows);
  const count = linkGroups(windows).find((g) => g.color === c)?.windowIds.length ?? 0;
  const label = c[0]!.toUpperCase() + c.slice(1);
  return (
    <Row label={tt`${label} group`} help={tl(settingDef(key).help)}>
      <span className="ls-swatch" style={{ background: LINK_COLORS[c] }} />
      <ColorPicker
        label={tt`${label} group colour`}
        alpha={false}
        value={value || LINK_COLOR_DEFAULTS[c]}
        onChange={(hex) => setSetting(key, hex.slice(0, 7) as never)}
      />
      <span className="ls-hint tnum">
        {count} {tl('window')}
        {count === 1 ? '' : 's'}
      </span>
      {value && (
        <Button size="xs" variant="ghost" onClick={() => setSetting(key, '' as never)}>
          {tl('Default')}
        </Button>
      )}
    </Row>
  );
}

function Monitors() {
  const [, bump] = useState(0);
  useEffect(() => {
    installDisplayTracking();
    void refreshDisplay().then(() => bump((x) => x + 1));
  }, []);
  const mons = currentMonitors();
  return (
    <Row
      label={tl('Monitors')}
      help={tl('Screens detected now. A browser sees one screen; the desktop app lists them all.')}
    >
      <span className="ls-hint tnum" data-testid="ls-monitors">
        {mons
          .map((m) => `${m.name}${m.primary ? ' (primary)' : ''} ${m.width}×${m.height}`)
          .join(' · ')}
      </span>
    </Row>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ls-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function LayoutSettings() {
  return (
    <div className="ls-win" data-testid="layout-settings">
      <div className="ls-scroll">
        <Section title={tl('Grid')}>
          <BoolRow k="layout.snapToGrid" />
          <NumRow k="layout.gridSize" />
          <NumRow k="layout.gap" />
          <BoolRow k="layout.lock" />
        </Section>
        <Section title={tl('Headers & tabs')}>
          <EnumRow k="layout.headerDensity" />
          <EnumRow k="layout.headerStyle" />
          <EnumRow k="layout.tabPosition" />
          <RibbonRow />
          <ThemeRow />
        </Section>
        <Section title={tl('New windows open')}>
          <EnumRow k="layout.openChart" label={tl('Chart')} />
          <EnumRow k="layout.openDom" label={tl('DOM')} />
          <EnumRow k="layout.openTape" label={tl('Tape')} />
          <EnumRow k="layout.openModule" label={tl('Other windows')} />
          <EnumRow k="layout.detachMode" />
          <EnumRow k="layout.dockPlacement" />
          <EnumRow k="layout.floatPlacement" />
          <NumRow k="layout.newWindowWidth" />
          <NumRow k="layout.newWindowHeight" />
        </Section>
        <Section title={tl('Link-group colours')}>
          {(['red', 'green', 'blue', 'yellow', 'purple'] as const).map((c) => (
            <LinkColorRow key={c} c={c} />
          ))}
        </Section>
        <Section title={tl('Multi-monitor restore')}>
          <BoolRow k="layout.restoreMonitors" />
          <EnumRow k="layout.restoreMode" />
          <Monitors />
        </Section>
      </div>
      <footer className="ls-foot">
        <span className="muted">{tl('Saved automatically · also in Settings → Layout')}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => resetSection('layout')}>
          <RotateCcw size={12} /> {tl('Reset layout settings')}
        </Button>
      </footer>
    </div>
  );
}

registerModule({ id: 'layout-settings', label: 'Layout Settings', view: LayoutSettings });

const toggle = (k: 'layout.snapToGrid' | 'layout.lock' | 'layout.ribbonHidden') => ({
  run: () => setSetting(k, !getSetting(k)),
});

registerCommands([
  {
    id: 'layout.snap-toggle',
    label: 'Layout: Toggle window snapping',
    group: 'Layout',
    ...toggle('layout.snapToGrid'),
  },
  {
    id: 'layout.lock-toggle',
    label: 'Layout: Lock / unlock layout',
    group: 'Layout',
    ...toggle('layout.lock'),
  },
  {
    id: 'layout.ribbon-toggle',
    label: 'Layout: Show / hide ribbon',
    group: 'Layout',
    ...toggle('layout.ribbonHidden'),
  },
  {
    id: 'layout.density-toggle',
    label: 'Layout: Compact / normal headers',
    group: 'Layout',
    run: () =>
      setSetting(
        'layout.headerDensity',
        getSetting('layout.headerDensity') === 'compact' ? 'normal' : 'compact',
      ),
  },
  {
    id: 'layout.tabs-toggle',
    label: 'Layout: Layout tabs top / bottom',
    group: 'Layout',
    run: () =>
      setSetting(
        'layout.tabPosition',
        getSetting('layout.tabPosition') === 'top' ? 'bottom' : 'top',
      ),
  },
  {
    id: 'layout.restore-mode',
    label: 'Layout: Multi-monitor restore exact / fit',
    group: 'Layout',
    run: () =>
      setSetting(
        'layout.restoreMode',
        getSetting('layout.restoreMode') === 'fit' ? 'exact' : 'fit',
      ),
  },
  {
    id: 'layout.reset',
    label: 'Layout: Reset layout settings',
    group: 'Layout',
    run: () => resetSection('layout'),
  },
]);
