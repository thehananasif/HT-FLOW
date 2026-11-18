import { expect, test, type Page } from '@playwright/test';

/** Samples requestAnimationFrame for `ms` and returns the median / p95 / worst frame interval. */
async function frameStats(page: Page, ms: number) {
  return page.evaluate(
    (dur) =>
      new Promise<{ median: number; p95: number; worst: number; frames: number }>((resolve) => {
        const d: number[] = [];
        let last = performance.now();
        const end = last + dur;
        const step = (t: number) => {
          d.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(step);
          else {
            const s = [...d].sort((a, b) => a - b);
            resolve({
              median: s[Math.floor(s.length / 2)]!,
              p95: s[Math.floor(s.length * 0.95)]!,
              worst: s[s.length - 1]!,
              frames: s.length,
            });
          }
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
}

test('applying indicators keeps the frame cadence (no lag)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Perf Tester');
  await inputs.nth(1).fill('perftester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500); // history load

  const base = await frameStats(page, 1500);

  // Add a stack of indicators, incl. order-flow ones (VWAP, cumulative delta, cluster statistic).
  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  await expect(dlg).toBeVisible();
  const add = ['EMA', 'RSI', 'VWAP', 'Cumulative Delta', 'Cluster Statistic', 'MACD + Histogram'];
  for (const name of add) {
    await dlg.getByPlaceholder('Search indicators…').fill(name);
    await dlg
      .getByRole('button', { name: `Add ${name}`, exact: true })
      .first()
      .click();
  }
  await page.getByTestId('indicators-apply').click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('indicators-button').first()).toHaveText(
    `Indicators (${add.length})`,
  );

  // Live data keeps streaming; frames must keep coming at a usable cadence.
  const after = await frameStats(page, 3000);
  test.info().annotations.push({
    type: 'frames',
    description: `before ${JSON.stringify(base)} after ${JSON.stringify(after)}`,
  });
  // Generous (headless CI shares the CPU): the median frame stays well under a 30 fps budget
  // relative to the baseline, and no single frame freezes the UI.
  expect(after.median).toBeLessThan(Math.max(34, base.median * 2));
  expect(after.worst).toBeLessThan(500);
  expect(after.frames).toBeGreaterThan(30);
  expect(errors).toEqual([]);
});
