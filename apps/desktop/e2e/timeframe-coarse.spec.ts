import { expect, test, type Page } from '@playwright/test';

// Regression: switching a chart to 4 hours (and other coarse timeframes) froze the page —
// the few bars left the view "scrolled past the start", which asked the simulated feed for
// 240 bars' worth of older history (40 days ≈ 28M ticks) on the main thread, again and again.

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Timeframe Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

/** Installs a long-task observer; returns the longest main-thread block since install. */
async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __maxTask: number; __tasks: number };
    w.__maxTask = 0;
    w.__tasks = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        w.__maxTask = Math.max(w.__maxTask, e.duration);
        w.__tasks++;
      }
    }).observe({ type: 'longtask' });
  });
}

async function resetLongTasks(page: Page) {
  await page.evaluate(() => ((window as unknown as { __maxTask: number }).__maxTask = 0));
}

const maxTask = (page: Page) =>
  page.evaluate(() => (window as unknown as { __maxTask: number }).__maxTask);

/** Round-trip through the main thread: how long the page takes to answer an evaluate. */
async function responsiveMs(page: Page) {
  const t0 = Date.now();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return Date.now() - t0;
}

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Timeframe' }).first().click();
  await page.getByRole('menuitem', { name: 'Timeframe dialog…' }).click();
}

/** Picks a chip in the open timeframe dialog; returns ms from Apply to the next painted frame. */
async function applyChip(page: Page, chip: string) {
  const dlg = page.getByTestId('timeframe-dialog');
  await expect(dlg).toBeVisible();
  await page.getByTestId(`tf-chip-${chip}`).click();
  const t0 = Date.now();
  await page.getByTestId('tf-apply').click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('.win-hdr .ht-chip', { hasText: chip }).first()).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return Date.now() - t0;
}

const barCount = async (page: Page) =>
  Number(await page.getByTestId('chart-bars').first().getAttribute('data-count'));

async function ready(page: Page) {
  const host = page.getByTestId('chart-footprint').first();
  await expect(host.locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/Loading .* history/)).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);
  await watchLongTasks(page);
  return host;
}

const spanOf = (t: string | null) => (t ?? '').split(' · ')[0];

test('coarse timeframes (1h … 1W) open quickly and keep the page responsive', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'tfcoarse1');
  await ready(page);
  const before = await page.getByTestId('history-range').first().textContent();

  for (const chip of ['H4', 'H1', 'D', 'W', 'H4']) {
    await resetLongTasks(page);
    await openDialog(page);
    const ms = await applyChip(page, chip);
    console.log(`${chip}: first paint ${ms} ms`);
    expect(ms, `${chip}: Apply → first paint`).toBeLessThan(1500);
    // Bars render and the page keeps answering.
    await expect.poll(() => barCount(page), { message: `${chip}: bars` }).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    expect(await responsiveMs(page), `${chip}: page responsive`).toBeLessThan(300);
    expect(await maxTask(page), `${chip}: longest main-thread task`).toBeLessThan(1000);
  }
  // No runaway history generation: the loaded range is unchanged by coarse timeframes.
  expect(spanOf(await page.getByTestId('history-range').first().textContent())).toBe(
    spanOf(before),
  );
  expect(errors).toEqual([]);
});

test('4 h via the TF menu and the command palette; left-scroll still loads older history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'tfcoarse2');
  const host = await ready(page);

  // TF menu → Minute → H4.
  await page.getByRole('button', { name: 'Timeframe' }).first().click();
  await page.getByRole('menuitem', { name: '4 hours', exact: true }).click();
  await expect(page.locator('.win-hdr .ht-chip', { hasText: 'H4' }).first()).toBeVisible();
  await expect.poll(() => barCount(page)).toBeGreaterThan(0);
  expect(await responsiveMs(page)).toBeLessThan(300);

  // Command palette → "Chart: Timeframe dialog" → D, then back to H4.
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('Timeframe dialog');
  await palette.getByRole('option').filter({ hasText: 'Chart: Timeframe dialog' }).first().click();
  expect(await applyChip(page, 'D')).toBeLessThan(1500);
  await openDialog(page);
  expect(await applyChip(page, 'H4')).toBeLessThan(1500);
  await page.waitForTimeout(500);
  expect(await maxTask(page)).toBeLessThan(1000);

  // A deliberate drag to the left still asks for older history, one bounded chunk at a time.
  const range = page.getByTestId('history-range').first();
  const before = spanOf(await range.textContent());
  const box = (await host.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => spanOf(await range.textContent())).not.toBe(before);
  await page.waitForTimeout(500);
  expect(await responsiveMs(page)).toBeLessThan(300);
  expect(errors).toEqual([]);
});
