import { en, type Strings } from './en';

export type { Strings };
export type Locale = 'en';

const dictionaries: Record<Locale, Strings> = { en };
let locale: Locale = 'en';

export function setLocale(l: Locale): void {
  locale = l;
}

/** Translate a key with {var} interpolation. All user-facing strings go through here (English first; Urdu later). */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  let s: string = dictionaries[locale][key] ?? en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
