import { expect, test } from '@playwright/test';

test('login page: footprint animation canvas runs, brand logo shows, toggle turns it off', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  const canvas = page.getByTestId('login-anim');
  await expect(canvas).toBeAttached();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  const logo = page.getByTestId('brand-logo');
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
    .toBe(true);

  // The canvas is painted (not blank) and keeps changing.
  const snap = () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const a = await snap();
  expect(a.length).toBeGreaterThan(5000);
  await page.waitForTimeout(1500);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-frames')))
    .toBeGreaterThan(10);
  expect(await snap()).not.toBe(a);

  await page.screenshot({ path: '../../docs/screenshots/login-animation.png' });

  // About dialog via the Command Palette is only available after login; here: turn the animation off.
  await page.getByTestId('login-anim-toggle').click();
  await expect(page.getByTestId('login-anim')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('login-anim')).toHaveCount(0);
  await expect(page.getByTestId('login-anim-toggle')).toHaveText('Animated background: off');
  expect(errors).toEqual([]);
});

test('login page: reduced motion draws a still frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('login-anim')).toHaveAttribute('data-state', 'static');
});

test('Command Palette: About HT Flow shows the brand logo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Brand Tester');
  await inputs.nth(1).fill('brand1');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('About HT Flow');
  await palette.getByRole('option', { name: /About HT Flow/ }).click();
  await expect(page.getByTestId('about-dialog')).toBeVisible();
  await expect(page.getByTestId('about-logo')).toBeVisible();
});
