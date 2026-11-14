import { expect, test, type Page } from '@playwright/test';

// The browser preview cannot call the venues' exchange-info endpoints (no CORS); the desktop core
// does (Rust tests cover the parsing with fixtures). Here a discovered list is injected through
// the test hook and must reach the picker, the Data manager and the palette.
const row = (venue: string, symbol: string, base: string, tickSize: number, market = 'perp') => ({
  venue,
  market,
  symbol,
  base,
  quote: 'USDT',
  settle: 'USDT',
  inverse: false,
  tickSize,
  pricePrecision: 4,
  lotStep: 1,
  qtyPrecision: 0,
  minQty: 1,
  contractSize: 1,
});

const REPORT = {
  refreshedAtMs: Date.now(),
  stale: false,
  sources: [
    {
      id: 'bitget',
      label: 'Bitget futures',
      ok: true,
      fetchedAtMs: Date.now(),
      count: 2,
      instruments: [
        row('bitget', 'ZORKQUUXUSDT', 'ZORKQUUX', 0.0001),
        row('bitget', 'BTCUSDT', 'BTC', 0.1),
      ],
    },
    {
      id: 'bybit-spot',
      label: 'Bybit spot',
      ok: false,
      error: 'HTTP 403',
      fetchedAtMs: 0,
      count: 0,
      instruments: [],
    },
  ],
};

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Discovery Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('symbol discovery: a symbol only in the discovered list is found and counted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((r) => {
    (window as unknown as { __HTFLOW_DISCOVERY__: unknown }).__HTFLOW_DISCOVERY__ = r;
  }, REPORT);
  await createAccount(page, 'discovery1');

  // Instrument picker: the discovered symbol is searchable under its venue group.
  await page.getByTestId('instrument-picker').first().click();
  const picker = page.getByTestId('instrument-picker-popover');
  await picker.getByLabel('Search instruments').fill('zorkquux');
  const opt = picker.getByRole('option').filter({ hasText: 'ZORKQUUXUSDT' });
  await expect(opt).toHaveCount(1);
  await expect(opt).toContainText('Bitget');
  // Streams through the Bitget connector: desktop app only in the browser preview.
  await expect(opt).toContainText('Desktop app');
  await page.keyboard.press('Escape');

  // Command palette: "Refresh symbol list" exists and runs.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('refresh symbol');
  await palette.getByRole('option').filter({ hasText: 'Refresh symbol list' }).first().click();
  await expect(palette).toHaveCount(0);

  // Data manager: per-venue counts and the failed source.
  await page.keyboard.press('Control+k');
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('open data manager');
  await palette.getByRole('option').filter({ hasText: 'Data manager' }).first().click();
  const lists = page.getByTestId('symbol-lists');
  await expect(lists).toBeVisible();
  await expect(lists.getByTestId('symbol-lists-total')).toContainText('2 symbols');
  await expect(lists.getByTestId('symbols-bitget')).toContainText('2');
  await expect(lists.getByTestId('symbols-bybit-spot')).toContainText('Kept last list: HTTP 403');
  expect(errors).toEqual([]);
});
