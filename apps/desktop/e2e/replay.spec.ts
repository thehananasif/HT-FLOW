import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Replay Trader');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByTestId('recovery-code').locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('replay CLZ6 from the Replay window: badge, control bar, play, pause, step', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay1');
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.getByTestId('ribbon-replay').click();
  await expect(page.getByTestId('replay-window')).toBeVisible();
  await expect(page.getByTestId('replay-data-info')).toContainText('CLZ6');
  await page.getByTestId('replay-start').click();

  await expect(page.getByLabel('Running replay')).toBeVisible({ timeout: 20_000 });
  // The Replay window opened as a tab next to the chart: bring the chart back to front.
  const tab = page.locator('.dv-tab', { hasText: 'Footprint' });
  for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    await tab.dispatchEvent(ev, { button: 0 });
  const bar = page.getByTestId('replay-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ht-badge--replay', { hasText: 'Replay' }).first()).toBeVisible();
  const clock = page.getByTestId('replay-clock');
  const t0 = await clock.textContent();

  await bar.getByRole('button', { name: '100×' }).click();
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveText(/Pause/);
  await expect(clock).not.toHaveText(t0 ?? '', { timeout: 5000 });
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveText(/Play/);

  const paused = await clock.textContent();
  await page.waitForTimeout(500);
  await expect(clock).toHaveText(paused ?? '');

  const ticks = bar.locator('.rp-clock .muted');
  const before = await ticks.textContent();
  await page.getByTestId('replay-step-tick').click();
  await expect(ticks).not.toHaveText(before ?? '');
  const afterTick = await ticks.textContent();
  await page.getByTestId('replay-step-bar').click();
  await expect(ticks).not.toHaveText(afterTick ?? '');
  expect(errors).toEqual([]);
});

async function startReplayOnChart(page: Page) {
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.getByTestId('ribbon-replay').click();
  await expect(page.getByTestId('replay-window')).toBeVisible();
  await page.getByTestId('replay-start').click();
  await expect(page.getByLabel('Running replay')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('replay-bar')).toBeVisible({ timeout: 20_000 });
}

test('Replay window opens in its own split next to the chart (not a tab over it)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay2');
  await startReplayOnChart(page);
  // Both are visible at the same time: no tab switching needed.
  await expect(page.getByTestId('replay-window')).toBeVisible();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  const w = (await page.getByTestId('replay-window').boundingBox())!;
  const c = (await page.getByTestId('chart-footprint').boundingBox())!;
  expect(w.x + w.width <= c.x + 2 || c.x + c.width <= w.x + 2).toBe(true);
  expect(errors).toEqual([]);
});

test('Hide future bars is a real toggle: ghost candles appear when it is off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay3');
  await startReplayOnChart(page);
  const bar = page.getByTestId('replay-bar');
  const toggle = bar.getByRole('checkbox', { name: 'Hide future bars' });
  await expect(toggle).toBeChecked();
  await bar.getByTestId('replay-step-bar').click();
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  const hidden = await canvas.screenshot();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await page.waitForTimeout(400);
  const ghost = await canvas.screenshot();
  expect(Buffer.compare(hidden, ghost)).not.toBe(0);
  // The Replay window shows the same state and the palette has a command for it.
  await expect(
    page.getByRole('checkbox', { name: 'Hide future bars (off = ghost candles)' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Hide future bars (off = ghost candles)' }).check();
  await expect(toggle).toBeChecked();
  await page.waitForTimeout(400);
  expect(Buffer.compare(ghost, await canvas.screenshot())).not.toBe(0);
  expect(errors).toEqual([]);
});

test('replay orders fill in replay time and show B / S tags on the chart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay4');
  await startReplayOnChart(page);
  const bar = page.getByTestId('replay-bar');
  await bar.getByTestId('replay-step-bar').click();
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  const tags = page.getByRole('checkbox', { name: 'B / S fill tags on bars' });
  // Deterministic signals instead of sleeps: the chart canvas carries `data-frame` (bumped after
  // every drawn frame) and `data-replay-tags` (tags drawn in the last frame).
  const frame = async () => Number(await canvas.getAttribute('data-frame'));
  /** Screenshot taken only after a frame newer than `since` has been drawn. */
  const shotAfter = async (since: number) => {
    await expect.poll(frame).toBeGreaterThan(since);
    return canvas.screenshot();
  };
  await tags.uncheck();
  await expect(canvas).toHaveAttribute('data-replay-tags', '0');
  const before = await canvas.screenshot();
  await tags.check();
  // The Trading panel follows the active window: activate the replay chart first.
  await page.getByTestId('chart-footprint').click({ position: { x: 120, y: 120 } });
  await page.getByRole('button', { name: 'BUY MARKET' }).click();
  await expect(page.getByLabel('Replay account').getByText('LONG 1')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-replay-tags', '1');
  const after = await canvas.screenshot();
  expect(Buffer.compare(before, after)).not.toBe(0);
  const f0 = await frame();
  await tags.uncheck();
  await expect(canvas).toHaveAttribute('data-replay-tags', '0');
  const off = await shotAfter(f0);
  // Tags off again: the chart goes back to what it looked like without them.
  expect(Buffer.compare(after, off)).not.toBe(0);
  expect(errors).toEqual([]);
});

test('bookmarks persist per replay template', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay5');
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.getByTestId('ribbon-replay').click();
  page.once('dialog', (d) => void d.accept('My practice'));
  await page.getByRole('button', { name: 'Save as template' }).click();
  const templates = page.getByLabel('Replay templates');
  await expect(templates.getByText('My practice')).toBeVisible();
  await templates.getByRole('button', { name: 'Load' }).click();
  const bar = page.getByTestId('replay-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await bar.getByTestId('replay-step-bar').click();
  await bar.getByRole('button', { name: '+ Bookmark' }).click();
  await bar.getByTestId('replay-step-bar').click();
  await bar.getByRole('button', { name: '+ Bookmark' }).click();
  await expect(bar.locator('.rp-mark')).toHaveCount(2);
  await expect(templates.getByText('2 bookmarks')).toBeVisible();
  // Reload the template: bookmarks come back with it.
  await templates.getByRole('button', { name: 'Load' }).click();
  await expect(bar.locator('.rp-mark')).toHaveCount(2, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('start, change speed, step, stop: the chart goes back to live without replay bars', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'replay6');
  await startReplayOnChart(page);
  const bar = page.getByTestId('replay-bar');
  await bar.getByRole('button', { name: '1000×' }).click();
  await expect(bar.getByRole('button', { name: '1000×' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: '5×', exact: true }).click();
  await expect(bar.getByRole('button', { name: '5×', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await bar.getByTestId('replay-step-bar').click();
  await bar.getByTestId('replay-step-tick').click();
  await bar.getByTestId('replay-stop').click();
  await expect(page.getByTestId('replay-bar')).toHaveCount(0);
  await expect(page.getByLabel('Running replay')).toHaveCount(0);
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await expect(page.locator('.ht-badge--replay', { hasText: 'Replay' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('replay runs on downloaded exchange history when nothing is recorded locally', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Stand-in for the native backfill: one trade per second, prices in ticks (0.1).
  await page.addInitScript(() => {
    (globalThis as Record<string, unknown>).__HTFLOW_REPLAY_HISTORY__ = async (r: {
      from: number;
      to: number;
      onProgress?: (p: number) => void;
    }) => {
      const out: { ts: number; px: number; qty: number; side: string; id: number }[] = [];
      let id = 1;
      for (let t = Math.ceil(r.from / 1000) * 1000; t <= r.to; t += 1000, id++)
        out.push({
          ts: t,
          px: 600_000 + ((id * 7) % 40) - 20,
          qty: 0.01,
          side: id % 2 ? 'buy' : 'sell',
          id,
        });
      r.onProgress?.(1);
      return out;
    };
  });
  await createAccount(page, 'replay7');
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.getByTestId('ribbon-replay').click();
  await page.getByTestId('replay-instrument').click();
  await page.getByText('BTCUSDT · Binance Futures', { exact: true }).first().click();
  await expect(page.getByTestId('replay-data-info')).toContainText('BTCUSDT');
  await page.getByTestId('replay-start').click();
  await expect(page.getByLabel('Running replay')).toBeVisible({ timeout: 20_000 });
  const bar = page.getByTestId('replay-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 });
  const clock = page.getByTestId('replay-clock');
  const t0 = await clock.textContent();
  await bar.getByRole('button', { name: '100×' }).click();
  await page.getByTestId('replay-play').click();
  await expect(clock).not.toHaveText(t0 ?? '', { timeout: 5000 });
  await bar.getByTestId('replay-stop').click();
  await expect(page.getByTestId('replay-bar')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an invalid replay range is reported and blocks Start', async ({ page }) => {
  await createAccount(page, 'replay8');
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.getByTestId('ribbon-replay').click();
  await page.getByLabel('To', { exact: true }).fill('2999-01-01T00:00');
  await expect(page.getByText('To is in the future')).toBeVisible();
  await expect(page.getByTestId('replay-start')).toBeDisabled();
});
