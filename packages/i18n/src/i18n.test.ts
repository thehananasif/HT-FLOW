import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { ur } from './ur';
import {
  getLocale,
  isLocale,
  plural,
  setLocale,
  subscribeLocale,
  t,
  translateLiteral,
} from './index';

const tokens = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();

describe('Urdu dictionary', () => {
  it('has every en.ts key and no extras', () => {
    const missing = Object.keys(en).filter((k) => !(k in ur));
    const extra = Object.keys(ur).filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('keeps the {placeholders} of every string exactly', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(tokens(ur[k]), k).toEqual(tokens(en[k]));
    }
  });

  it('is really translated: Arabic script in nearly every string, no empty values', () => {
    const arabic = /[؀-ۿ]/;
    const keys = Object.keys(en) as (keyof typeof en)[];
    const empty = keys.filter((k) => ur[k].trim() === '');
    expect(empty).toEqual([]);
    const untranslated = keys.filter((k) => !arabic.test(ur[k]) && ur[k] === en[k]);
    // Only trading terms / symbols kept in English may be identical (Bid, DOM, CVD, '{n} px' …).
    expect(untranslated.length).toBeLessThan(25);
  });

  it('uses Western digits only', () => {
    for (const k of Object.keys(ur) as (keyof typeof ur)[])
      expect(/[۰-۹٠-٩]/.test(ur[k]), k).toBe(false);
  });
});

describe('locale switching', () => {
  afterEach(() => setLocale('en'));

  it('translates, interpolates and falls back to English', () => {
    expect(t('login.submit')).toBe('Log in');
    setLocale('ur');
    expect(getLocale()).toBe('ur');
    expect(t('login.profiles', { n: 3 })).toBe('اس پی سی پر پروفائلز: 3');
    expect(t('chartMenu.footprint')).toBe('Footprint');
  });

  it('notifies subscribers once per change', () => {
    let n = 0;
    const off = subscribeLocale(() => n++);
    setLocale('ur');
    setLocale('ur');
    setLocale('en');
    off();
    setLocale('ur');
    expect(n).toBe(2);
  });

  it('translates registered English literals and passes unknown text through', () => {
    expect(translateLiteral('Linear')).toBe('Linear');
    setLocale('ur');
    expect(translateLiteral('Linear')).toBe(ur['chartMenu.linear']);
    expect(translateLiteral('Some other command')).toBe('Some other command');
  });

  it('pluralises English only', () => {
    expect(plural(2)).toBe('s');
    expect(plural(1)).toBe('');
    setLocale('ur');
    expect(plural(2)).toBe('');
  });

  it('knows the supported locales', () => {
    expect(isLocale('ur')).toBe(true);
    expect(isLocale('xx')).toBe(false);
  });
});
