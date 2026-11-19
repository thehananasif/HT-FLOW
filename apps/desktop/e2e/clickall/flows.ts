/**
 * Framework-agnostic UI flows on top of the crawler `Driver` (used by the WebdriverIO native
 * smoke test; the Playwright spec uses Playwright locators for the same flows).
 */
import type { Driver, StepResult } from './core';
import { takeErrors } from './core';

const q = (s: string) => JSON.stringify(s);

/** Marks the nth element matching `selector` whose trimmed text equals `text` (or any, if omitted). */
export async function markEl(
  d: Driver,
  selector: string,
  text?: string,
  nth = 0,
): Promise<boolean> {
  return d.exec<boolean>(`(() => {
    document.querySelectorAll('[data-clickall-target]').forEach((e) => e.removeAttribute('data-clickall-target'));
    const all = [...document.querySelectorAll(${q(selector)})].filter((e) =>
      ${text === undefined ? 'true' : `(e.textContent || '').trim() === ${q(text)}`});
    const el = all[${nth}];
    if (!el) return false;
    el.setAttribute('data-clickall-target', '1');
    return true;
  })()`);
}

export async function clickEl(d: Driver, selector: string, text?: string, nth = 0): Promise<void> {
  if (!(await markEl(d, selector, text, nth)))
    throw new Error(`not found: ${selector}${text ? ` "${text}"` : ''} #${nth}`);
  await d.click('[data-clickall-target]');
}

/** Sets an input's value the way React expects (native setter + input event). */
export async function fill(d: Driver, selector: string, nth: number, value: string): Promise<void> {
  const ok = await d.exec<boolean>(`(() => {
    const el = document.querySelectorAll(${q(selector)})[${nth}];
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`input not found: ${selector} #${nth}`);
}

export async function waitFor(d: Driver, expression: string, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await d.exec<boolean>(`!!(${expression})`).catch(() => false)) return true;
    await d.sleep(200);
  }
  return false;
}

export const PASSWORD = 'Str0ng!Passw0rd';
export const PIN = '135790';

/** Creates a local profile (with a quick-unlock PIN) and waits for the dashboard. */
export async function createAccountFlow(d: Driver, username: string): Promise<void> {
  await waitFor(d, `document.querySelector('button')`);
  await clickEl(d, 'button', 'Create account', 0);
  await waitFor(d, `document.querySelector('form.create-form')`);
  const inp = 'form.create-form input';
  await fill(d, inp, 0, 'Native Tester');
  await fill(d, inp, 1, username);
  await fill(d, inp, 3, PASSWORD);
  await fill(d, inp, 4, PASSWORD);
  await fill(d, 'form.create-form input[placeholder="••••••"]', 0, PIN);
  await clickEl(
    d,
    'form.create-form button[type="submit"], form.create-form button',
    'Create account',
    0,
  );
  if (!(await waitFor(d, `document.querySelector('[data-testid="recovery-code"]')`, 60_000)))
    throw new Error('recovery code screen did not appear');
  await clickEl(d, 'label', 'I have saved my recovery code', 0);
  await waitFor(
    d,
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Continue' && !b.disabled)`,
    5000,
  );
  await clickEl(d, 'button', 'Continue');
  if (!(await waitFor(d, `document.querySelector('[data-testid="trading-panel"]')`, 60_000)))
    throw new Error('dashboard did not appear');
}

/** Runs one named check; any throw or new page error fails it. */
export async function check(
  d: Driver,
  name: string,
  out: StepResult[],
  fn: () => Promise<string | void>,
): Promise<void> {
  const step: StepResult = {
    surface: 'Native paths',
    control: name,
    role: 'check',
    status: 'pass',
    effect: '',
    notes: [],
  };
  try {
    step.effect = (await fn()) ?? 'ok';
  } catch (e) {
    step.status = 'fail';
    step.notes.push(String((e as Error).message ?? e).split('\n')[0]!);
  }
  const errs = await takeErrors(d).catch(() => [] as string[]);
  if (errs.length) {
    step.status = 'fail';
    step.notes.push(...errs);
  }
  out.push(step);
}

/**
 * Invokes a native Tauri command through the WebView's IPC bridge. Resolves to `ok: …` or
 * `error: …` (a graceful error such as a region block is a pass); only a hang fails.
 */
export async function invokeNative(
  d: Driver,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 45_000,
): Promise<string> {
  const id = `__native_${Math.random().toString(36).slice(2)}`;
  await d.exec(`(() => {
    const ipc = window.__TAURI_INTERNALS__;
    window[${q(id)}] = null;
    if (!ipc) { window[${q(id)}] = 'error: no Tauri IPC (web build)'; return null; }
    ipc.invoke(${q(cmd)}, ${JSON.stringify(args)}).then(
      (v) => { window[${q(id)}] = 'ok: ' + JSON.stringify(v).slice(0, 200); },
      (e) => { window[${q(id)}] = 'error: ' + JSON.stringify(e).slice(0, 200); },
    );
    return null;
  })()`);
  if (!(await waitFor(d, `window[${q(id)}] !== null`, timeoutMs)))
    throw new Error(`${cmd} did not answer within ${timeoutMs / 1000}s`);
  return d.exec<string>(`window[${q(id)}]`);
}
