import { expect, test, type Locator, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('WebGL');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function runCommand(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill(text);
  await palette.getByRole('option').filter({ hasText: text }).first().click();
  await expect(palette).toHaveCount(0);
}

/** Distinct colours on the WebGL canvas (read back through a 2D copy). */
async function glColours(gl: Locator): Promise<number> {
  return gl.evaluate((el) => {
    const src = el as HTMLCanvasElement;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const x = c.getContext('2d')!;
    x.drawImage(src, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length && seen.size < 50; i += 4 * 37)
      seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return seen.size;
  });
}

test('switch charts to WebGL2 from the palette: GL canvas draws, Canvas 2D again', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'webgl1');
  const chart = page.getByTestId('chart-footprint');
  await expect(chart.locator('canvas').first()).toBeVisible();
  await page.waitForTimeout(1500); // history load

  // Auto in headless Chromium (software GL) stays on Canvas 2D.
  await expect(chart.locator('canvas[data-renderer="canvas2d"]').first()).toBeAttached();

  await chart
    .locator('canvas')
    .last()
    .click({ position: { x: 200, y: 200 } });
  await runCommand(page, 'Chart: Renderer — WebGL2 (GPU)');
  const gl = chart.locator('canvas[data-role="chart-gl"]').first();
  await expect(gl).toBeAttached();
  await expect(chart.locator('canvas[data-renderer="webgl2"]').first()).toBeAttached();
  await page.waitForTimeout(500);
  expect(await glColours(gl)).toBeGreaterThan(3);

  await runCommand(page, 'Chart: Renderer — Canvas 2D');
  await expect(chart.locator('canvas[data-role="chart-gl"]')).toHaveCount(0);
  await expect(chart.locator('canvas[data-renderer="canvas2d"]').first()).toBeAttached();
  expect(errors).toEqual([]);
});
