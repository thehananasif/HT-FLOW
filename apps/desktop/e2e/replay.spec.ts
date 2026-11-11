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
