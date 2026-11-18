import { afterEach, describe, expect, it } from 'vitest';
import { en, setLocale, translateLiteral } from '@htflow/i18n';
import { MODULES } from '../shell/modules';
import { SCHEMA, SECTIONS, settingDef, type SettingKey } from './settings';

const enValues = new Set<string>(Object.values(en));

/** Units, numbers and similar text that read the same in every language. */
const SAME_EVERYWHERE =
  /^[^A-Za-z]*$|^(px|ms|s|MB|GB|fps|USD|min|%|bars|ticks|days|[0-9a-z]{1,3})$/i;

/** Trading terms and names Urdu-speaking traders use in English (intentionally not translated). */
const KEPT_IN_ENGLISH = new Set([
  'English',
  'اردو (Urdu, RTL)',
  'Scalper',
  'WebGL2 (GPU)',
  'Canvas 2D',
  'Depth of market',
  'Candlesticks',
  'Heikin-Ashi',
  'Bid x Ask',
  'Imbalance',
  'Viridis',
  '1 tick',
  '2 tick',
  '5 tick',
  '10 tick',
  '20 tick',
  '50 tick',
  'Market',
  'Limit',
  'Time in force',
  'Good till cancelled',
  'Immediate or cancel',
  'Fill or kill',
  'Commitments of Traders',
  'Legacy',
  'Depth conflation',
  'Cool-down',
  'Price collar',
  'Cascade',
  'Exact',
  'Fit to screens',
  'Stable',
  'Beta',
  'Smart DOM',
  'Smart Tape',
  'Bid/Ask Tape',
  'Forward curve',
  'Delta Divergence',
]);

describe('Settings pages are translatable', () => {
  afterEach(() => setLocale('en'));

  it('every settings text (section, group, label, help, options, placeholders) has an en.ts entry', () => {
    const missing = new Set<string>();
    const need = (s: unknown) => {
      if (
        typeof s === 'string' &&
        s.trim() &&
        !enValues.has(s) &&
        !KEPT_IN_ENGLISH.has(s) &&
        !SAME_EVERYWHERE.test(s)
      )
        missing.add(s);
    };
    for (const s of SECTIONS) {
      need(s.label);
      need(s.description);
    }
    for (const k of Object.keys(SCHEMA) as SettingKey[]) {
      const d = settingDef(k);
      need(d.group);
      need(d.label);
      need(d.help);
      if ('placeholder' in d) need(d.placeholder);
      if ('patternHint' in d) need(d.patternHint);
      if ('options' in d) d.options.forEach((o) => need(o.label));
      if ('special' in d) d.special?.forEach((o) => need(o.label));
    }
    expect([...missing]).toEqual([]);
  });

  it('every ribbon module name and group has an en.ts entry', () => {
    const missing = MODULES.flatMap((m) => [m.label, m.group]).filter(
      (s) => !enValues.has(s) && !KEPT_IN_ENGLISH.has(s) && !SAME_EVERYWHERE.test(s),
    );
    expect(missing).toEqual([]);
  });

  it('shows Urdu section names, labels and ribbon names when the language is Urdu', () => {
    setLocale('ur');
    expect(SECTIONS.find((s) => s.id === 'general')!.label).toBe(translateLiteral('General'));
    expect(SECTIONS.find((s) => s.id === 'general')!.label).not.toBe('General');
    const lang = settingDef('general.language');
    expect(lang.label).not.toBe('Language');
    expect(/[؀-ۿ]/.test(lang.label)).toBe(true);
    expect(MODULES.find((m) => m.id === 'watchlist')!.label).toBe('واچ لسٹ');
    // The raw schema keeps English: stored values and ids never change with the language.
    expect(SCHEMA['general.language'].label).toBe('Language');
    setLocale('en');
    expect(settingDef('general.language').label).toBe('Language');
  });
});
