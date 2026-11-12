import { expect, test, type Locator, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Chart Types');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

/** Distinct colours on a canvas — a blank chart has only one or two. */
async function inkColours(canvas: Locator): Promise<number> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length && seen.size < 50; i += 4 * 37)
      seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return seen.size;
  });
}

async function pickBarType(page: Page, chip: string) {
  await page.getByRole('button', { name: 'Timeframe' }).first().click();
  await page.getByRole('menuitem', { name: 'Timeframe dialog…' }).click();
  const dlg = page.getByTestId('timeframe-dialog');
  await expect(dlg).toBeVisible();
  await page.getByTestId(`tf-chip-${chip}`).click();
  await page.getByTestId('tf-apply').click();
  await expect(dlg).toBeHidden();
}

test('switch a chart to Renko, Point & Figure and TPO without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'charttypes1');
  const chart = page.getByTestId('chart-footprint');
  await expect(chart.locator('canvas').first()).toBeVisible();
  await page.waitForTimeout(1500); // history load

  // Renko 2 (price-based bars drawn as candles / footprint)
  await pickBarType(page, 'Renko 2');
  await expect(
    page.locator('.win-hdr .ht-chip[aria-pressed="true"]', { hasText: 'Renko 2' }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(await inkColours(chart.locator('canvas').first())).toBeGreaterThan(5);

  // Point & Figure 2 × 3: own X / O renderer and a style button
  await pickBarType(page, 'P&F 2x3');
  await expect(page.getByTestId('chart-type-settings')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await inkColours(chart.locator('canvas').first())).toBeGreaterThan(5);

  // TPO template from the template menu
  await page.getByTestId('template-menu').first().click();
  await page.getByRole('menuitem', { name: 'TPO Chart' }).click();
  const tpo = page.getByTestId('chart-tpo');
  await expect(tpo).toBeVisible();
  await page.waitForTimeout(500);
  expect(await inkColours(tpo.locator('canvas').first())).toBeGreaterThan(5);

  // TPO style settings open and apply live
  await page.getByTestId('chart-type-settings').click();
  await page.getByRole('button', { name: 'Blocks' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  expect(errors).toEqual([]);
});

test('every additional template renders; timeframe presets can be configured', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'charttypes2');
  await page.waitForTimeout(1500);
  for (const [label, id] of [
    ['Order Flow (Light)', 'order-flow-light'],
    ['Imbalance Chart', 'imbalance'],
    ['On-Chart Liquidity Map', 'onchart-liquidity'],
    ['Multi-timeframe Chart', 'mtf'],
    ['Volume Histogram', 'volume-histogram'],
    ['COT Chart', 'cot'],
    ['Delta Profile', 'delta-profile'],
  ] as const) {
    await page.getByTestId('template-menu').first().click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const c = page.getByTestId(`chart-${id}`);
    await expect(c).toBeVisible();
    await page.waitForTimeout(250);
    expect(await inkColours(c.locator('canvas').first()), label).toBeGreaterThan(3);
    if (id === 'cot') await expect(page.getByText('Sample data')).toBeVisible();
  }

  // Multi-timeframe: side-by-side panes
  await page.getByTestId('template-menu').first().click();
  await page.getByRole('menuitem', { name: 'Multi-timeframe Chart' }).click();
  await page.getByTestId('chart-type-settings').click();
  await page.getByRole('button', { name: 'Side by side' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('chart-mtf').getByTestId('mtf-pane')).toHaveCount(2);

  // Configure: add a custom Renko chip and pin it to the header
  await page.getByRole('button', { name: 'Timeframe' }).first().click();
  await page.getByRole('menuitem', { name: 'Configure…' }).click();
  await page.getByRole('button', { name: 'Add Renko preset' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('tf-chip-Renko 8').click(); // configure mode: click = pin
  await page.getByTestId('tf-configure').click(); // Done
  await page.getByTestId('tf-chip-Renko 8').click();
  await page.getByTestId('tf-apply').click();
  await expect(page.locator('.win-hdr .ht-chip', { hasText: 'Renko 8' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
