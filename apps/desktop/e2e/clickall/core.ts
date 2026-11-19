/**
 * Framework-agnostic "click everything" crawler. The Playwright spec (web build, every CI run) and
 * the WebdriverIO native smoke test (real Tauri .exe under tauri-driver, workflow_dispatch) both
 * drive the app through this file: they only provide a small `Driver` adapter.
 *
 * For each surface (a module window, the title bar, a dialog, a menu...) the crawler enumerates the
 * visible controls from the live DOM (see inpage.js), clicks each one, and records:
 *  - errors: page errors, console.error, unhandled promise rejections (minus BENIGN_CONSOLE)
 *  - responsiveness: the status-bar heartbeat keeps beating
 *  - layout: nothing overflows its window horizontally, no visible text overlaps
 *  - effect: something observable changed (DOM structure, a dialog / menu, a window, a toast);
 *    "no visible effect" is a warning, not a failure.
 * Opened menus get their first item picked; opened dialogs get their tabs and Apply exercised and
 * are then closed (Cancel / Close / Escape).
 */
import { isBenign, isDestructive } from './policy';

export interface Driver {
  /** Evaluates a JavaScript expression in the page and returns its JSON value. */
  exec<T>(expression: string): Promise<T>;
  /** Real (trusted) click on the element matching the CSS selector. */
  click(
    selector: string,
    opts?: { button?: 'left' | 'right'; x?: number; y?: number },
  ): Promise<void>;
  /** Right-click at client coordinates. */
  contextClick?(x: number, y: number): Promise<void>;
  press(key: string): Promise<void>;
  /** Screenshot of the element matching the selector (or the page); returns a report-relative path. */
  screenshot(name: string, selector?: string): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  /** Errors the framework captured outside the page hooks (e.g. Playwright `pageerror`). */
  drainExtraErrors?(): string[];
}

export type Status = 'pass' | 'warn' | 'fail' | 'skip';

export interface StepResult {
  surface: string;
  control: string;
  role: string;
  status: Status;
  effect: string;
  notes: string[];
}

export interface SurfaceResult {
  name: string;
  group: string;
  screenshot?: string;
  controls: number;
  steps: StepResult[];
  layout: { overflow: string[]; overlap: string[] };
  errors: string[];
  durationMs: number;
}

export interface ControlInfo {
  key: string;
  role: string;
  label: string;
  testid?: string;
  disabled: boolean;
  href?: string;
  target?: string;
  tag: string;
  options?: number;
}

interface Snapshot {
  sig: string;
  elements: number;
  layers: string[];
  toasts: number;
  lastToast: string;
  windows: number;
  url: string;
  nativeDialogs: number;
}

export interface CrawlOptions {
  /** Max controls exercised per surface (repeated rows are already capped in-page). */
  maxControls?: number;
  /** Wall-clock budget per surface; the rest is recorded as skipped. */
  budgetMs?: number;
  /** Wait after a click before checking. */
  settleMs?: number;
  /** Re-opens the surface if a click closed it (e.g. a "Done" button). */
  reopen?: () => Promise<void>;
  /** Labels/test ids skipped in this surface in addition to the global DESTRUCTIVE list. */
  skip?: RegExp[];
  /** Exercise opened dialogs (tabs, Apply, then close). Default true. */
  dialogs?: boolean;
}

const q = (s: string) => JSON.stringify(s);
const CA = 'window.__CLICKALL__';

export async function installed(d: Driver): Promise<boolean> {
  return d.exec<boolean>(`!!${CA}`);
}

export async function takeErrors(d: Driver): Promise<string[]> {
  const inPage = await d.exec<{ kind: string; message: string; stack?: string }[]>(
    `${CA}.takeErrors()`,
  );
  const extra = d.drainExtraErrors?.() ?? [];
  const all = [
    ...inPage
      .filter((e) => !isBenign(`${e.kind}: ${e.message}`))
      .map((e) => `${e.kind}: ${e.message}${e.stack ? ` @ ${e.stack}` : ''}`),
    ...extra.filter((m) => !isBenign(m)),
  ];
  return [...new Set(all)];
}

/** True when the heartbeat advances within `ms` (main thread and timers alive). */
export async function heartbeatAlive(d: Driver, ms = 1500): Promise<boolean> {
  const a = await d.exec<number>(`${CA}.beat()`);
  if (a < 0) return true; // not on the dashboard (login screen): nothing to measure
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await d.sleep(150);
    if ((await d.exec<number>(`${CA}.beat()`)) > a) return true;
  }
  return false;
}

async function snap(d: Driver): Promise<Snapshot> {
  return d.exec<Snapshot>(`${CA}.snapshot()`);
}

function effectOf(a: Snapshot, b: Snapshot): string {
  const out: string[] = [];
  const opened = b.layers.filter((l) => !a.layers.includes(l));
  const closed = a.layers.filter((l) => !b.layers.includes(l));
  if (opened.length) out.push(`opened ${opened.join(', ')}`);
  if (closed.length) out.push(`closed ${closed.join(', ')}`);
  if (b.windows !== a.windows) out.push(`windows ${a.windows}→${b.windows}`);
  if (b.toasts > a.toasts || (b.lastToast && b.lastToast !== a.lastToast))
    out.push(`toast "${b.lastToast}"`);
  if (b.url !== a.url) out.push('navigated');
  if (b.nativeDialogs > a.nativeDialogs) out.push('native dialog');
  if (!out.length && b.elements !== a.elements) out.push(`DOM ${a.elements}→${b.elements} nodes`);
  if (!out.length && b.sig !== a.sig) out.push('state changed');
  return out.join('; ');
}

async function closeLayers(d: Driver, keep = 0): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const layers = await d.exec<{ role: string }[]>(`${CA}.layers()`);
    if (layers.length <= keep) return;
    await d.press('Escape');
    await d.sleep(80);
  }
}

export async function layoutOf(
  d: Driver,
  root: string,
): Promise<{ overflow: string[]; overlap: string[] }> {
  return d.exec(`${CA}.layout(${q(root)})`);
}

/** Screenshots the surface root; returns the report-relative path. */
export async function shotOf(d: Driver, root: string, name: string): Promise<string | undefined> {
  const ok = await d.exec<boolean>(`${CA}.markRoot(${q(root)})`);
  return d.screenshot(name, ok ? '[data-clickall-root]' : undefined);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'x';

const seenDialogs = new Set<string>();

/**
 * Exercises an opened dialog shallowly: tabs (each once, with a layout check), an "Apply" button,
 * then closes it with Cancel / Close / OK / Escape. Returns notes and failures.
 */
async function exerciseDialog(
  d: Driver,
  surface: string,
  title: string,
  steps: StepResult[],
  layoutAcc: { overflow: string[]; overlap: string[] },
): Promise<void> {
  const root = 'top-layer';
  const name = `${surface} › dialog "${title}"`;
  if (!seenDialogs.has(title)) {
    seenDialogs.add(title);
    await shotOf(d, root, `dialog-${slug(title)}`);
  }
  const controls = await d.exec<ControlInfo[]>(`${CA}.controls(${q(root)})`);
  const lay = await layoutOf(d, root);
  layoutAcc.overflow.push(...lay.overflow.map((x) => `[${title}] ${x}`));
  layoutAcc.overlap.push(...lay.overlap.map((x) => `[${title}] ${JSON.stringify(x)}`));
  for (const c of controls.filter((c) => c.role === 'tab' && !c.disabled).slice(0, 12)) {
    if (!(await d.exec<boolean>(`${CA}.mark(${q(root)}, ${q(c.key)})`))) continue;
    await d.click('[data-clickall-target]').catch(() => undefined);
    await d.sleep(120);
    const errs = await takeErrors(d);
    const l = await layoutOf(d, root);
    layoutAcc.overflow.push(...l.overflow.map((x) => `[${title} › ${c.label}] ${x}`));
    layoutAcc.overlap.push(...l.overlap.map((x) => `[${title} › ${c.label}] ${JSON.stringify(x)}`));
    steps.push({
      surface: name,
      control: `tab "${c.label}"`,
      role: 'tab',
      status: errs.length ? 'fail' : 'pass',
      effect: 'tab',
      notes: errs,
    });
  }
  const pick = (re: RegExp) =>
    controls.find((c) => !c.disabled && c.role === 'button' && re.test(c.label));
  const apply = pick(/^apply$/i);
  if (apply && (await d.exec<boolean>(`${CA}.mark(${q(root)}, ${q(apply.key)})`))) {
    await d.click('[data-clickall-target]').catch(() => undefined);
    await d.sleep(150);
    const errs = await takeErrors(d);
    steps.push({
      surface: name,
      control: 'Apply',
      role: 'button',
      status: errs.length ? 'fail' : 'pass',
      effect: 'applied',
      notes: errs,
    });
  }
  const close = pick(/^(cancel|close|done|ok|not now|later|dismiss|got it)$/i);
  let how = 'Escape';
  if (close && (await d.exec<boolean>(`${CA}.mark(${q(root)}, ${q(close.key)})`))) {
    await d.click('[data-clickall-target]').catch(() => undefined);
    how = close.label;
    await d.sleep(120);
  }
  await closeLayers(d);
  const errs = await takeErrors(d);
  steps.push({
    surface: name,
    control: `close (${how})`,
    role: 'button',
    status: errs.length ? 'fail' : 'pass',
    effect: 'closed',
    notes: errs,
  });
}

/**
 * Clicks every visible control of one surface. `root` is a CSS selector, 'active-panel' (the
 * focused dock window including its header) or 'document'.
 */
export async function crawlSurface(
  d: Driver,
  name: string,
  group: string,
  root: string,
  opts: CrawlOptions = {},
): Promise<SurfaceResult> {
  const t0 = Date.now();
  const max = opts.maxControls ?? 80;
  const budget = opts.budgetMs ?? 90_000;
  const settle = opts.settleMs ?? 140;
  const steps: StepResult[] = [];
  const layout = { overflow: [] as string[], overlap: [] as string[] };
  const surfaceErrors = await takeErrors(d); // errors raised while opening the surface
  if (!(await d.exec<boolean>(`${CA}.exists(${q(root)})`))) {
    return {
      name,
      group,
      controls: 0,
      steps: [
        {
          surface: name,
          control: '(surface)',
          role: 'surface',
          status: 'fail',
          effect: '',
          notes: [`surface root ${root} not found`],
        },
      ],
      layout,
      errors: surfaceErrors,
      durationMs: Date.now() - t0,
    };
  }
  const screenshot = await shotOf(d, root, `surface-${slug(group)}-${slug(name)}`);
  const first = await layoutOf(d, root);
  layout.overflow.push(...first.overflow);
  layout.overlap.push(...first.overlap.map((x) => JSON.stringify(x)));

  const controls = await d.exec<ControlInfo[]>(`${CA}.controls(${q(root)})`);
  let done = 0;
  for (const c of controls) {
    const label = c.label || c.testid || c.key;
    const step: StepResult = {
      surface: name,
      control: label,
      role: c.role,
      status: 'pass',
      effect: '',
      notes: [],
    };
    steps.push(step);
    if (c.disabled) {
      step.status = 'skip';
      step.notes.push('disabled');
      continue;
    }
    if (isDestructive(c.label, c.testid) || opts.skip?.some((re) => re.test(label))) {
      step.status = 'skip';
      step.notes.push('destructive / excluded by policy');
      continue;
    }
    if (c.href && /^(https?:|mailto:)/i.test(c.href)) {
      step.status = 'skip';
      step.notes.push('external link (opens the OS browser)');
      continue;
    }
    if (done >= max || Date.now() - t0 > budget) {
      step.status = 'skip';
      step.notes.push('surface budget exhausted');
      continue;
    }
    done++;
    if (!(await d.exec<boolean>(`${CA}.exists(${q(root)})`))) {
      if (!opts.reopen) {
        step.status = 'skip';
        step.notes.push('surface closed by an earlier control');
        continue;
      }
      await opts.reopen();
      await d.sleep(200);
    }
    const before = await snap(d);
    if (!(await d.exec<boolean>(`${CA}.mark(${q(root)}, ${q(c.key)})`))) {
      step.status = 'skip';
      step.notes.push('control no longer present (re-rendered by an earlier click)');
      continue;
    }
    try {
      if (c.tag === 'select') {
        const picked = await d.exec<string | null>(`${CA}.cycleSelect()`);
        step.notes.push(`picked option "${picked ?? '?'}"`);
      } else {
        await d.click('[data-clickall-target]');
      }
    } catch (e) {
      step.status = 'warn';
      step.notes.push(`not clickable: ${String((e as Error).message ?? e).split('\n')[0]}`);
      await closeLayers(d);
      continue;
    }
    await d.sleep(settle);
    let after = await snap(d);
    step.effect = effectOf(before, after);

    // Menus / listboxes that opened: pick the first enabled item.
    const newLayers = after.layers.filter((l) => !before.layers.includes(l));
    const menu = newLayers.find((l) => l.startsWith('menu:') || l.startsWith('listbox:'));
    if (menu) {
      const items = await d.exec<ControlInfo[]>(`${CA}.controls('top-layer')`);
      const firstItem = items.find(
        (i) =>
          !i.disabled &&
          /^(menuitem|menuitemcheckbox|menuitemradio|option)$/.test(i.role) &&
          !isDestructive(i.label, i.testid),
      );
      if (firstItem && (await d.exec<boolean>(`${CA}.mark('top-layer', ${q(firstItem.key)})`))) {
        await d.click('[data-clickall-target]').catch(() => undefined);
        await d.sleep(settle);
        step.notes.push(`picked "${firstItem.label}"`);
        after = await snap(d);
      }
    }
    const dialog = after.layers.find(
      (l) =>
        (l.startsWith('dialog:') || l.startsWith('alertdialog:')) && !before.layers.includes(l),
    );
    if (dialog && opts.dialogs !== false) {
      await exerciseDialog(d, name, dialog.replace(/^[a-z]+:/, ''), steps, layout);
    }

    const errs = await takeErrors(d);
    if (errs.length) {
      step.status = 'fail';
      step.notes.push(...errs);
    }
    if (c.role === 'tab') {
      const l = await layoutOf(d, root);
      layout.overflow.push(...l.overflow.map((x) => `[tab ${c.label}] ${x}`));
      layout.overlap.push(...l.overlap.map((x) => `[tab ${c.label}] ${JSON.stringify(x)}`));
    }
    if (done % 10 === 0 && !(await heartbeatAlive(d))) {
      step.status = 'fail';
      step.notes.push('app stopped responding (heartbeat frozen)');
    }
    if (!step.effect && step.status === 'pass') {
      step.status = 'warn';
      step.notes.push('no visible effect');
    }
    await closeLayers(d);
  }
  if (!(await heartbeatAlive(d))) {
    steps.push({
      surface: name,
      control: '(heartbeat)',
      role: 'check',
      status: 'fail',
      effect: '',
      notes: ['app stopped responding (heartbeat frozen)'],
    });
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    name,
    group,
    screenshot,
    controls: controls.length,
    steps,
    layout: { overflow: uniq(layout.overflow), overlap: uniq(layout.overlap) },
    errors: surfaceErrors,
    durationMs: Date.now() - t0,
  };
}

/** Runs registry commands one by one (closing whatever they open). */
export async function runCommands(
  d: Driver,
  cmds: { id: string; label: string }[],
  settleMs = 160,
): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const c of cmds) {
    const before = await snap(d);
    const step: StepResult = {
      surface: 'Command Palette',
      control: `${c.label} (${c.id})`,
      role: 'command',
      status: 'pass',
      effect: '',
      notes: [],
    };
    try {
      // Run inside a try/catch in the page, so a throw comes back with its stack frames.
      const threw = await d.exec<string | null>(
        `(() => { try { window.__HTFLOW_INTROSPECT__.runCommand(${q(c.id)}); return null; } ` +
          `catch (e) { return String(e && e.message) + ' @ ' + String(e && e.stack || '')` +
          `.split('\\n').slice(1, 5).map((l) => l.trim()).join(' | '); } })()`,
      );
      if (threw) {
        step.status = 'fail';
        step.notes.push(`threw: ${threw}`);
      }
    } catch (e) {
      step.status = 'fail';
      step.notes.push(`threw: ${String((e as Error).message ?? e).split('\n')[0]}`);
    }
    await d.sleep(settleMs);
    const after = await snap(d);
    step.effect = effectOf(before, after);
    const errs = await takeErrors(d);
    if (errs.length) {
      step.status = 'fail';
      step.notes.push(...errs);
    }
    if (!step.effect && step.status === 'pass') {
      step.status = 'warn';
      step.notes.push('no visible effect');
    }
    out.push(step);
    await closeLayers(d);
  }
  if (!(await heartbeatAlive(d))) {
    out.push({
      surface: 'Command Palette',
      control: '(heartbeat)',
      role: 'check',
      status: 'fail',
      effect: '',
      notes: ['app stopped responding (heartbeat frozen)'],
    });
  }
  return out;
}

/** Failures of a surface (layout issues count as failures). */
export function failuresOf(s: SurfaceResult): string[] {
  const f: string[] = [];
  for (const e of s.errors) f.push(`${s.name}: while opening: ${e}`);
  for (const st of s.steps)
    if (st.status === 'fail') f.push(`${st.surface} › ${st.control}: ${st.notes.join(' | ')}`);
  for (const o of s.layout.overflow) f.push(`${s.name}: overflows its window: ${o}`);
  for (const o of s.layout.overlap) f.push(`${s.name}: overlapping text: ${o}`);
  return f;
}
