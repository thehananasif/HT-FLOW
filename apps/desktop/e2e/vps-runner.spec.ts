import { expect, test, type Page } from '@playwright/test';

// Native SSH side mocked (web build): window.__HTFLOW_VPS_MOCK__ switches the VPS panel to an
// in-memory VPS that speaks the same output formats as the real remote commands.
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;

async function createAccount(page: Page, username: string) {
  await page.addInitScript(() => {
    (window as unknown as { __HTFLOW_VPS_MOCK__: boolean }).__HTFLOW_VPS_MOCK__ = true;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('VPS Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function openVpsTab(page: Page) {
  await page.getByTestId('ribbon-strategies').click();
  const win = page.getByTestId('strategies-window');
  await win.getByRole('tab', { name: 'VPS runner' }).click();
}

test('VPS runner: add with host-key pinning, deploy, monitor, stop/start, journal, remove', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'vps1');
  await openVpsTab(page);
  await expect(page.getByTestId('vps-empty')).toBeVisible();

  // Add VPS: an invalid host blocks Next; then the trust-on-first-use dialog shows the key.
  await page.getByTestId('vps-add').click();
  const add = page.getByTestId('vps-add-dialog');
  await add.getByLabel('Host', { exact: true }).fill('bad_host');
  await add.getByLabel('User').fill('trader');
  await add.getByLabel('Private key text').fill(KEY);
  await expect(page.getByTestId('vps-add-next')).toBeDisabled();
  await add.getByLabel('Host', { exact: true }).fill('vps.example.com');
  await page.getByTestId('vps-add-next').click();
  await expect(page.getByTestId('vps-trust-fp')).toContainText('SHA256:');
  await page.getByTestId('vps-trust').click();

  // Saved, connected and probed (Node.js present).
  const status = page.getByTestId('vps-status');
  await expect(status.getByTestId('vps-conn')).toHaveText('Connected');
  await expect(status.getByTestId('vps-node')).toHaveText('v22.11.0');
  await expect(status.getByTestId('vps-fingerprint')).toContainText('SHA256:');

  // Deploy a strategy (paper) to the VPS: bundles the runner, uploads and starts it.
  await page.getByTestId('vps-deploy').click();
  const dlg = page.getByTestId('vps-deploy-dialog');
  await expect(dlg).toContainText('Paper trading');
  await page.getByTestId('vps-deploy-go').click();
  await expect(dlg).toBeHidden({ timeout: 45_000 });
  const runners = page.getByTestId('vps-runners');
  await expect(runners.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByTestId('vps-log')).toContainText('started');
  await expect(runners.locator('[data-testid^="vps-runner-pnl-"]')).toContainText('$');

  // Fills → Journal (VPS account).
  await page.getByTestId('vps-import').click();

  // Stop / start.
  await page.getByTestId('vps-stop').click();
  await expect(runners.getByText('Stopped', { exact: true })).toBeVisible();
  await page.getByTestId('vps-start').click();
  await expect(runners.getByText('Running', { exact: true })).toBeVisible();

  // Remote command console streams output.
  await page.getByTestId('vps-console').locator('summary').click();
  await page.getByTestId('vps-run').click();
  await expect(page.getByTestId('vps-console-out')).toContainText('v22.11.0');

  // Remove the runner.
  await page.getByTestId('vps-remove-runner').click();
  await expect(runners).toContainText('Nothing deployed yet.');

  // The Journal lists the imported VPS trade under the VPS account.
  await page.getByTestId('ribbon-journal').click();
  const jr = page.getByTestId('journal-window');
  await jr.getByLabel('Account').selectOption('vps');
  await expect(jr.getByRole('cell', { name: 'BTCUSDT' }).first()).toBeVisible();
  await expect(jr.getByRole('cell', { name: 'vps' }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('VPS runner: missing Node.js shows install steps; unreachable host shows an error', async ({
  page,
}) => {
  await createAccount(page, 'vps2');
  await openVpsTab(page);

  await page.getByTestId('vps-add').click();
  let add = page.getByTestId('vps-add-dialog');
  await add.getByLabel('Host', { exact: true }).fill('nonode.example.com');
  await add.getByLabel('User').fill('trader');
  await add.getByRole('radio', { name: 'Password' }).click();
  await add.getByRole('textbox', { name: 'Password' }).fill('pw');
  await page.getByTestId('vps-add-next').click();
  await page.getByTestId('vps-trust').click();
  await expect(page.getByTestId('vps-node-help')).toContainText('apt-get install -y nodejs');
  await expect(page.getByTestId('vps-deploy')).toBeDisabled();

  await page.getByTestId('vps-add').click();
  add = page.getByTestId('vps-add-dialog');
  await add.getByLabel('Name').fill('Down');
  await add.getByLabel('Host', { exact: true }).fill('down.example.com');
  await add.getByLabel('User').fill('trader');
  await add.getByLabel('Private key text').fill(KEY);
  await page.getByTestId('vps-add-next').click();
  await expect(page.getByTestId('vps-add-error')).toContainText('Connection refused');
});
