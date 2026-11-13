import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Import Tester');
  await inputs.nth(1).fill('importtester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('ribbon-connections').click();
}

const CSV = `timestamp;price;qty;side
2024-03-01T10:00:00Z;100.50;2;buy
2024-03-01T10:00:01Z;100.45;1.5;sell
broken;1;1;buy
2024-03-01T10:00:03Z;100.55;3;buy
2024-03-01T10:00:04Z;100.60;1;sell
`;

test('CSV importer: auto-detect, preview, validation errors, import, chart and replay', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Data manager' }).first().click();
  await page.getByRole('button', { name: 'Import CSV…' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'sample-ticks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  // Auto-detected: semicolon, header, trades; preview shows the bad row with its line number.
  await expect(page.getByLabel('Delimiter')).toHaveValue(';');
  await expect(page.getByLabel('Contents')).toHaveValue('trades');
  await expect(page.getByLabel('Price column')).toHaveValue('1');
  await expect(page.getByText(/Preview: first 5 rows/)).toBeVisible();
  await expect(page.locator('.dm-preview tr[data-bad]')).toContainText('Bad time');
  await page.screenshot({ path: 'test-results/csv-import-mapping.png' });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported 4 rows as sample-ticks \(CSV\)/)).toBeVisible();
  await expect(page.locator('.dm-errors')).toContainText('Line 4: Bad time');
  await page.screenshot({ path: 'test-results/csv-import-done.png' });
  await page.getByRole('button', { name: 'Open in Replay' }).click();
  await expect(page.getByText('Replay ready')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // The dataset is listed and can be removed.
  await expect(page.getByLabel('Imported files')).toContainText('csv:sample-ticks');
  await page.getByLabel('Remove csv:sample-ticks').click();
  await expect(page.getByLabel('Imported files')).toHaveCount(0);
});

test('Custom WebSocket connector: wizard test against a mock server, then saved connection', async ({
  page,
}) => {
  const subscribes: string[] = [];
  await page.routeWebSocket('ws://mock.test/feed', (ws) => {
    ws.onMessage((m) => {
      subscribes.push(String(m));
      ws.send(JSON.stringify({ result: null, id: 1 }));
      ws.send(JSON.stringify({ e: 'trade', p: '64000.5', q: '0.25', m: false, T: Date.now() }));
    });
  });
  await login(page);
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await page.getByLabel('Search providers').fill('custom');
  await page.getByRole('button', { name: /^Custom WebSocket\s*FREE$/ }).click();
  await expect(page.getByText(/Coming soon/)).toHaveCount(0);
  await page.getByLabel('WebSocket URL').fill('ws://mock.test/feed');
  await page.getByLabel('Symbol', { exact: true }).fill('BTCUSDT');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.cx-test')).toContainText('first message mapped: 1 trade');
  expect(subscribes[0]).toContain('btcusdt'.toUpperCase() + '@trade');
  // A mapping error is shown and blocks saving.
  await page.getByLabel('Field mapping').fill('{"price": "p"}');
  await expect(page.getByText(/needs a "qty" path/)).toBeVisible();
  await page
    .getByLabel('Field mapping')
    .fill('{"price":"p","qty":"q","side":"m","sideMode":"buyerMaker"}');
  await page.screenshot({ path: 'test-results/custom-ws-wizard.png' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Custom WebSocket').first()).toBeVisible();
  await expect(page.getByText('Custom feed')).toBeVisible();
});
