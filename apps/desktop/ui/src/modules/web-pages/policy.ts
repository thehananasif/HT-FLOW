/**
 * URL and domain allow-list policy for Web Pages. Mirrors the Rust core
 * (`src-tauri/src/webpage_cmds.rs`), which is the enforcing side in the desktop app; the UI uses
 * this to give early feedback and to validate stored data.
 */
import { normalizeUrl } from './nav';

/** True only for absolute http(s) URLs with a host and no user name / password. */
export function isOpenableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  return (
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    u.hostname !== '' &&
    u.username === '' &&
    u.password === ''
  );
}

/** Normalises one allow-list entry to `host` or `*.host`, or null when invalid. */
export function normalizeAllowEntry(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  const i = s.indexOf('://');
  if (i >= 0) s = s.slice(i + 3);
  s = s.split(/[/?#]/)[0] ?? '';
  const wild = s.startsWith('*.');
  const host = (wild ? s.slice(2) : s).replace(/\.+$/, '');
  const label = (l: string) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l);
  if (!host || !host.split('.').every(label)) return null;
  if (!host.includes('.') && host !== 'localhost') return null;
  return wild ? `*.${host}` : host;
}

export function normalizeAllowList(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const e = normalizeAllowEntry(r);
    if (e && !out.includes(e) && out.length < 50) out.push(e);
  }
  return out;
}

/** Empty list = every host. `a.com` matches itself + subdomains; `*.a.com` subdomains only. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  const h = host.toLowerCase().replace(/\.+$/, '');
  return allow.some((e) =>
    e.startsWith('*.')
      ? h.length > e.length - 2 && h.endsWith(e.slice(1))
      : h === e || h.endsWith(`.${e}`),
  );
}

/** The single check for "may this panel show this address". */
export function urlPermitted(raw: string, allow: readonly string[]): boolean {
  if (!isOpenableUrl(raw)) return false;
  return hostAllowed(new URL(raw).hostname, allow);
}

/** Typed address -> openable URL honouring the allow-list, with the reason when refused. */
export function checkAddress(
  input: string,
  allow: readonly string[],
): { ok: true; url: string } | { ok: false; reason: string } {
  const url = normalizeUrl(input);
  if (!url || !isOpenableUrl(url)) {
    return { ok: false, reason: 'Enter an http(s) address such as example.com' };
  }
  if (!urlPermitted(url, allow)) {
    return { ok: false, reason: 'That site is not in this panel’s allow-list' };
  }
  return { ok: true, url };
}

/** Parses the allow-list editor text (one entry per line or comma separated). */
export function parseAllowText(text: string): { list: string[]; rejected: string[] } {
  const parts = text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    list: normalizeAllowList(parts),
    rejected: parts.filter((p) => normalizeAllowEntry(p) === null),
  };
}
