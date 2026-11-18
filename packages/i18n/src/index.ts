import { en, type Strings } from './en';
import { ur } from './ur';

export type { Strings };
export type Locale = 'en' | 'ur';

export const LOCALES: Locale[] = ['en', 'ur'];
/** Locales written right-to-left (the document gets dir="rtl"; charts and numbers stay LTR). */
export const RTL_LOCALES: Locale[] = ['ur'];

const dictionaries: Record<Locale, Strings> = { en, ur };
let locale: Locale = 'en';
const listeners = new Set<() => void>();
let reverse: Map<string, keyof Strings> | null = null;

export function isLocale(l: string): l is Locale {
  return (LOCALES as string[]).includes(l);
}

export function getLocale(): Locale {
  return locale;
}

export function setLocale(l: Locale): void {
  if (l === locale) return;
  locale = l;
  listeners.forEach((fn) => fn());
}

/** Subscribe to locale changes (used by `useSyncExternalStore`). Returns the unsubscribe. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Translate a key with {var} interpolation. All user-facing strings go through here. */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  let s: string = dictionaries[locale][key] ?? en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/**
 * Translate an English string that was resolved at module load (command labels, registered with
 * `t()` before the language was known). Strings that are not an exact en.ts value pass through.
 */
export function translateLiteral<T extends string | undefined>(s: T): T {
  if (locale === 'en' || s === undefined) return s;
  if (!reverse) {
    reverse = new Map();
    for (const [k, v] of Object.entries(en)) reverse.set(v, k as keyof Strings);
  }
  const key = reverse.get(s);
  return (key ? t(key) : s) as T;
}

/** Plural suffix for the "{n} object{s}" style strings: English adds "s", Urdu has none. */
export function plural(n: number): string {
  return locale === 'en' && n !== 1 ? 's' : '';
}
