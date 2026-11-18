import { expect, test, type Page } from '@playwright/test';

/**
 * A fixed Deribit-style chain (two expiries, five strikes) served through the test hook of the
 * options feed, so no network is involved: max pain of the first expiry is 6850.
 */
const MOCK = `
  window.__optCalls = [];
  const DAY = 86400000;
  const q = (oi, vol, iv) => ({ bid: 1, ask: 2, bidSize: 1, askSize: 1, last: 1.5, volume: vol,
    openInterest: oi, change: 0, bidIv: iv - 0.005, askIv: iv + 0.005, markIv: iv, mark: 1.5 });
  const strikes = [6750, 6800, 6850, 6900, 6950];
  const expiry = (days, base) => ({
    expiry: Date.now() + days * DAY, series: 'weekly', forward: 6850,
    underlying: { symbol: 'X', bid: 6849, ask: 6851, bidSize: 1, askSize: 1, last: 6850 },
    strikes: strikes.map((k, i) => ({
      strike: k,
      call: { name: 'C' + k, kind: 'call', strike: k, expiry: 0, quote: q([900, 600, 300, 100, 50][i], 40 + i, base + Math.abs(i - 2) * 0.02) },
      put: { name: 'P' + k, kind: 'put', strike: k, expiry: 0, quote: q([50, 100, 300, 600, 900][i], 30 + i, base + 0.03 + Math.abs(i - 2) * 0.02) },
    })),
  });
  window.__HTFLOW_OPTIONS_CHAIN__ = async (root, id) => {
    window.__optCalls.push(root);
    return { root: 'BTC', source: 'deribit', sourceLabel: 'Deribit', simulated: false, model: 'b76',
      r: 0, q: 0, multiplier: 1, spot: 6850, priceDecimals: 0, currency: 'USD',
      expiries: [expiry(7, 0.5), expiry(14, 0.55)], updatedAt: Date.now() };
  };
`;

const notices = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __htflowIndicatorNotices: () => string[] }).__htflowIndicatorNotices(),
  );
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __optCalls: string[] }).__optCalls);

test('indicators: Options Board and Volatility Smile read the (mocked) options chain; profile, CMS and Margin Zones are available', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Options Ind');
  await inputs.nth(1).fill('optionsind');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500);

  // Lazy: the chain is not requested before an options indicator is on the chart.
  expect(await calls(page)).toEqual([]);

  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  const search = dlg.getByPlaceholder('Search indicators…');

  // The five formerly pending entries can all be added now.
  for (const name of [
    'Options Board (on-chart strikes/OI)',
    'Volatility Smile',
    'Market Profile & TPO',
    'CMS',
    'Margin Zones',
  ]) {
    await search.fill(name.split(' (')[0]!);
    await expect(dlg.getByRole('button', { name: `Add ${name}`, exact: true })).toBeEnabled();
  }

  await search.fill('Options Board');
  await dlg.getByRole('button', { name: 'Add Options Board (on-chart strikes/OI)' }).click();
  await search.fill('Volatility Smile');
  await dlg.getByRole('button', { name: 'Add Volatility Smile' }).click();
  await search.fill('Market Profile');
  await dlg.getByRole('button', { name: 'Add Market Profile & TPO' }).click();
  await search.fill('Margin Zones');
  await dlg.getByRole('button', { name: 'Add Margin Zones' }).click();
  await search.fill('CMS');
  await dlg.getByRole('button', { name: 'Add CMS' }).click();
  await page.getByTestId('indicators-apply').click();

  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText('Options board #1')).toBeAttached();
  await expect(legend.getByText('Vol smile #1')).toBeAttached();
  await expect(legend.getByText(/^Market profile/)).toBeAttached();
  await expect(legend.getByText(/^Margin zones/)).toBeAttached();
  await expect(legend.getByText(/^CMS /)).toBeAttached();

  // The chain was requested once the indicators were on the chart, and shows on the legend notes.
  await expect.poll(async () => (await calls(page)).length).toBeGreaterThan(0);
  await expect
    .poll(async () => (await notices(page)).find((n) => n.startsWith('Options board')) ?? '', {
      timeout: 10_000,
    })
    .toMatch(/Deribit · .* · max pain 6,850/);
  // Each note is written when that indicator's calc finishes (in a worker): wait for it rather than
  // reading once, since the Windows runner computes them later than the Options Board note.
  const note = (prefix: string) => async () =>
    (await notices(page)).find((n) => n.startsWith(prefix)) ?? '';
  await expect
    .poll(note('Vol smile'), { timeout: 10_000 })
    .toMatch(/Deribit · IV \d+–\d+% · .*ATM/);
  await expect
    .poll(note('Margin zones'), { timeout: 10_000 })
    .toMatch(/tiers 3\/5\/10\/25\/50\/100x/);

  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('indicators: without a hook the chart instrument gets a labelled simulated chain', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Options Sim');
  await inputs.nth(1).fill('optionssim');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500);

  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  await dlg.getByPlaceholder('Search indicators…').fill('Volatility Smile');
  await dlg.getByRole('button', { name: 'Add Volatility Smile' }).click();
  await page.getByTestId('indicators-apply').click();
  await expect
    .poll(async () => (await notices(page)).find((n) => n.startsWith('Vol smile')) ?? '', {
      timeout: 10_000,
    })
    .toMatch(/Sim \(simulated\)/);
  expect(errors).toEqual([]);
});
