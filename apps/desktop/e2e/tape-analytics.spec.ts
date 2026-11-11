import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Tape Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('Smart Tape and Market Pressure open from the ribbon and update', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'tapetester');

  await page.getByTestId('ribbon-smart-tape').click();
  await expect(page.getByTestId('tape-smart')).toBeVisible();
  const speed = page.getByTestId('tape-speed');
  // The mock feed keeps printing: the speed meter reports prints/s > 0.
  await expect(speed).not.toHaveText(/^0 prints/, { timeout: 20_000 });
  // The canvas is drawn (non-blank pixels near the top rows).
  const painted = await page.getByTestId('tape-canvas-smart').evaluate((c) => {
    const cv = c as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, Math.min(cv.height, 120)).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 200) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(50);

  await page.getByTestId('ribbon-market-pressure').click();
  const mp = page.getByTestId('market-pressure');
  await expect(mp).toBeVisible();
  const rows = mp.getByTestId('scanner-row');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(rows.first()).toContainText('% buy', { timeout: 20_000 });
  const before = await mp.getByTestId('scanner-table').innerText();
  await expect
    .poll(async () => (await mp.getByTestId('scanner-table').innerText()) !== before, {
      timeout: 30_000,
    })
    .toBe(true);
  // Mode chip switches the sort window.
  await mp.locator('.an-toolbar').getByRole('button', { name: '1m', exact: true }).click();
  await expect(mp.getByRole('button', { name: /1m ▾/ })).toBeVisible();
  expect(errors).toEqual([]);
});
