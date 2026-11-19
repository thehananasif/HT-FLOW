import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Preview-6 fix: no overlapping text. For the key screens at common laptop / desktop sizes and at
 * 125 % / 150 % Windows scaling (emulated with deviceScaleFactor and a smaller CSS viewport) no
 * two visible text boxes may overlap inside the app, and nothing in the title bar may overflow
 * or collide with the pinned window controls. Includes the replay control bar over the chart.
 */

interface Size {
  name: string;
  width: number;
  height: number;
  dpr: number;
}

const SIZES: Size[] = [
  { name: '1280x600', width: 1280, height: 600, dpr: 1 },
  { name: '1366x768', width: 1366, height: 768, dpr: 1 },
  { name: '1920x1080', width: 1920, height: 1080, dpr: 1 },
  // 125 % scaling: 1920x1080 and 1366x768 panels become 1536x864 / 1093x614 CSS pixels.
  { name: '1536x864@125%', width: 1536, height: 864, dpr: 1.25 },
  { name: '1093x614@125%', width: 1093, height: 614, dpr: 1.25 },
  // 150 % scaling of a 1920x1080 panel.
  { name: '1280x720@150%', width: 1280, height: 720, dpr: 1.5 },
];

async function newPage(browser: Browser, size: Size): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: `http://localhost:${Number(process.env.E2E_PORT ?? 1420)}`,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
  });
  return ctx.newPage();
}

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Crypto + Futures Overlap Check');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(800);
}

/** Runs in the page: pairs of visible text boxes inside `rootSelector` that overlap. */
function findTextOverlaps(rootSelector: string): string[] {
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) return [`no container ${rootSelector}`];
  interface T {
    el: Element;
    node: Node;
    r: { l: number; t: number; r: number; b: number };
    text: string;
    hit: Element | null;
  }
  const items: T[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('svg, script, style, [data-overlap-ok]')) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const cr of Array.from(range.getClientRects())) {
      let box = { l: cr.left, t: cr.top, r: cr.right, b: cr.bottom };
      // Text the author clipped (overflow hidden / ellipsis / scroller) is only visible inside it.
      for (let p: Element | null = el; p && p !== root.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (cs.overflowX !== 'visible') {
          box.l = Math.max(box.l, pr.left);
          box.r = Math.min(box.r, pr.right);
        }
        if (cs.overflowY !== 'visible') {
          box.t = Math.max(box.t, pr.top);
          box.b = Math.min(box.b, pr.bottom);
        }
      }
      if (box.r - box.l < 2 || box.b - box.t < 4) continue;
      if (box.r < 0 || box.b < 0 || box.l > innerWidth || box.t > innerHeight) continue;
      // Occluded by an unrelated element (another window, a popover): not visible, ignore.
      const hit = document.elementFromPoint(
        Math.min(Math.max((box.l + box.r) / 2, 0), innerWidth - 1),
        Math.min(Math.max((box.t + box.b) / 2, 0), innerHeight - 1),
      );
      box = { l: box.l, t: box.t, r: box.r, b: box.b };
      items.push({ el, node: n, r: box, text, hit });
    }
  }
  // Text covered by an unrelated non-text element (another window, a backdrop) is not visible.
  // Text covered by other text is exactly the overlap we are looking for, so it stays.
  const textEls = new Set(items.map((t) => t.el));
  for (let i = items.length - 1; i >= 0; i--) {
    const { el, hit } = items[i]!;
    const related =
      !!hit &&
      (hit.contains(el) ||
        el.contains(hit) ||
        textEls.has(hit) ||
        Array.from(textEls).some((t) => t.contains(hit)));
    if (!related) items.splice(i, 1);
  }
  const label = (t: T) =>
    `"${t.text.slice(0, 28)}" <${t.el.tagName.toLowerCase()}.${String(
      (t.el as HTMLElement).className || '',
    )
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(
        '.',
      )}> @${Math.round(t.r.l)},${Math.round(t.r.t)}-${Math.round(t.r.r)},${Math.round(t.r.b)}`;
  const out: string[] = [];
  for (let i = 0; i < items.length && out.length < 8; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.node === b.node) continue;
      const w = Math.min(a.r.r, b.r.r) - Math.max(a.r.l, b.r.l);
      const h = Math.min(a.r.b, b.r.b) - Math.max(a.r.t, b.r.t);
      // 1.5 px tolerance for sub-pixel rounding and glyph side bearings.
      if (w > 1.5 && h > 2) {
        out.push(`${label(a)}  overlaps  ${label(b)}  (${Math.round(w)}x${Math.round(h)})`);
        if (out.length >= 8) break;
      }
    }
  }
  return out;
}

/** Runs in the page: title-bar overflow checks. */
function titleBarProblems(): string[] {
  const bar = document.querySelector<HTMLElement>('header.titlebar');
  if (!bar) return ['no title bar'];
  const out: string[] = [];
  const barBox = bar.getBoundingClientRect();
  const controls = bar.querySelector<HTMLElement>('.win-controls');
  const cLeft = controls ? controls.getBoundingClientRect().left : barBox.right;
  if (bar.scrollWidth > bar.clientWidth + 1)
    out.push(`title bar scrolls: scrollWidth ${bar.scrollWidth} > ${bar.clientWidth}`);
  const kids = Array.from(bar.children).filter(
    (c) => c !== controls && (c as HTMLElement).getBoundingClientRect().width > 0,
  ) as HTMLElement[];
  let prevRight = -Infinity;
  for (const k of kids) {
    const cs = getComputedStyle(k);
    if (cs.display === 'none') continue;
    const r = k.getBoundingClientRect();
    const name = `${k.tagName.toLowerCase()}.${String(k.className).split(/\s+/)[0] ?? ''}`;
    if (r.right > cLeft + 0.5) out.push(`${name} runs under the window controls`);
    if (r.left < prevRight - 0.5 && r.width > 1) out.push(`${name} overlaps its left neighbour`);
    prevRight = Math.max(prevRight, r.right);
    // Text clipped without an ellipsis is cut mid-word (the original "HT FLO" bug).
    if (k.scrollWidth > k.clientWidth + 1 && cs.textOverflow !== 'ellipsis')
      out.push(`${name} is clipped (scrollWidth ${k.scrollWidth} > ${k.clientWidth})`);
  }
  // The app name is never truncated: either fully visible, or hidden and only the icon is shown.
  const logo = bar.querySelector<HTMLElement>('.tb-logo');
  if (logo && getComputedStyle(logo).display !== 'none') {
    const r = logo.getBoundingClientRect();
    if (logo.scrollWidth > logo.clientWidth + 1 || r.right > cLeft) out.push('app name is cut');
    const p = logo.parentElement!;
    if (p.scrollWidth > p.clientWidth + 1) out.push('brand is clipped');
  }
  const ws = bar.querySelector<HTMLElement>('.tb-workspace');
  if (ws && !ws.title) out.push('workspace name has no tooltip');
  return out;
}

test('the overlap detector flags overlapping text and ignores clipped / separate text', async ({
  page,
}) => {
  await page.setContent(`<div id="r" style="position:relative;font:14px sans-serif;width:300px;height:120px">
    <span style="position:absolute;left:10px;top:10px">Workspace: Crypto</span>
    <span style="position:absolute;left:60px;top:12px">Layout button</span>
    <span style="position:absolute;left:10px;top:60px">Apart</span>
    <div style="position:absolute;left:100px;top:60px;width:30px;overflow:hidden;white-space:nowrap">clipped text that runs on</div>
    <span style="position:absolute;left:140px;top:60px">next</span></div>`);
  const found = await page.evaluate(findTextOverlaps, '#r');
  expect(found).toHaveLength(1);
  expect(found[0]).toContain('Workspace');
  expect(found[0]).toContain('Layout');
});

const fail = (where: string, found: string[]) => found.map((f) => `${where}: ${f}`);

for (const size of SIZES) {
  test(`no overlapping text and a clean title bar at ${size.name}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await newPage(browser, size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await createAccount(page, `ovl-${size.name.replace(/\W/g, '')}`);
    const failures: string[] = [];

    // 1. Shell: title bar, ribbon, chart, trading panel, tabs and status bar.
    failures.push(...fail('title bar', await page.evaluate(titleBarProblems)));
    failures.push(...fail('shell', await page.evaluate(findTextOverlaps, '.app-root')));

    // 2. Replay control bar over the chart (the bar sits on top of the canvas).
    await page.getByTestId('chart-footprint').click({ position: { x: 100, y: 100 } });
    await page.getByTestId('ribbon-replay').click();
    await expect(page.getByTestId('replay-window')).toBeVisible();
    await page.getByTestId('replay-start').click();
    await expect(page.getByLabel('Running replay')).toBeVisible({ timeout: 20_000 });
    const tab = page.locator('.dv-tab', { hasText: 'Footprint' });
    for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      await tab.dispatchEvent(ev, { button: 0 });
    await expect(page.getByTestId('replay-bar')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    failures.push(...fail('replay bar', await page.evaluate(findTextOverlaps, '.app-root')));
    const barOk = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="replay-bar"]')!;
      const host = bar.parentElement!.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      const out: string[] = [];
      if (r.left < host.left - 1 || r.right > host.right + 1) out.push('bar leaves its chart');
      if (r.top < host.top - 1) out.push('bar taller than its chart');
      if (bar.scrollWidth > bar.clientWidth + 1) out.push('bar content overflows sideways');
      return out;
    });
    failures.push(...fail('replay bar box', barOk));

    // 3. Indicators dialog and command palette.
    await page.getByTestId('indicators-button').first().click();
    await expect(page.getByTestId('indicators-dialog')).toBeVisible();
    await page.waitForTimeout(300);
    failures.push(
      ...fail(
        'indicators dialog',
        await page.evaluate(findTextOverlaps, '[data-testid="indicators-dialog"]'),
      ),
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.waitForTimeout(200);
    failures.push(
      ...fail(
        'command palette',
        await page.evaluate(findTextOverlaps, '[role="dialog"][aria-label="Command palette"]'),
      ),
    );
    await page.keyboard.press('Escape');

    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });
}

for (const size of [SIZES[0]!, SIZES[4]!]) {
  test(`every module window has no overlapping text at ${size.name}`, async ({ browser }) => {
    test.setTimeout(420_000);
    const page = await newPage(browser, size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await createAccount(page, `ovm-${size.name.replace(/\W/g, '')}`);
    const modules = await page.evaluate(async () => {
      const load = (p: string) => import(/* @vite-ignore */ p);
      const m = await load('/src/shell/modules.ts');
      return (m.MODULES as { id: string; label: string }[]).map((x) => ({
        id: x.id,
        label: x.label,
      }));
    });
    const failures: string[] = [];
    for (const m of modules) {
      if (m.id === 'chart') continue;
      const groups = await page.locator('.dv-groupview').count();
      await page.getByTestId(`ribbon-${m.id}`).click({ timeout: 5000 });
      const opened = await page
        .waitForFunction((n) => document.querySelectorAll('.dv-groupview').length > n, groups, {
          timeout: 1200,
        })
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+k');
        await page
          .getByRole('dialog', { name: 'Command palette' })
          .getByPlaceholder('Search commands, symbols, layouts…')
          .fill(`Open ${m.label}`);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(600);
      for (const f of await page.evaluate(
        findTextOverlaps,
        '.dv-groupview.dv-active-group .dv-content-container',
      ))
        failures.push(`${m.id}: ${f}`);
      await page.keyboard.press('Escape');
      const close = page
        .locator('.dv-groupview.dv-active-group [aria-label="Close window"]')
        .first();
      if (await close.isVisible().catch(() => false)) await close.click({ timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });
}
