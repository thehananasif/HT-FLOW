import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Info Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByTestId('recovery-code').locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('Info group: RSS Reader, News and Calendar show offline sample content', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Deterministic offline run: every non-local request fails, as CORS does in the browser preview.
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await createAccount(page, 'infotester');

  await page.getByTestId('ribbon-rss').click();
  const rss = page.getByTestId('rss-reader');
  await expect(rss.getByText('Offline sample shown')).toBeVisible();
  await expect(rss.getByText('Central banks', { exact: true })).toBeVisible();
  await rss
    .getByText(/NEWUSDT perpetual contract \(sample\)/)
    .first()
    .click();
  await expect(rss.locator('.rss-headline')).toContainText('NEWUSDT');
  await expect(rss.getByRole('button', { name: /Open chart NEWUSDT/ })).toBeVisible();

  await page.getByTestId('ribbon-calendar').click();
  const cal = page.getByTestId('economic-calendar');
  await expect(cal.getByText(/Next high impact in/)).toBeVisible();
  await expect(cal.getByText(/\(sample\)/).first()).toBeVisible();
  await cal.getByRole('button', { name: 'High+' }).click();
  await expect(cal.locator('.impact-dots[data-impact="medium"]')).toHaveCount(0);

  await page.getByTestId('ribbon-news').click();
  const news = page.getByTestId('news-window');
  await expect(news.locator('.news-row').first()).toBeVisible();
  await expect(news.getByText(/offline sample/).first()).toBeVisible();

  await page.getByTestId('ribbon-traderstalk').click();
  const tt = page.getByTestId('traderstalk');
  await tt.getByLabel('Idea text').fill('Long above value #breakout');
  await tt.getByRole('button', { name: 'Post idea' }).click();
  await expect(tt.locator('.tt-msg')).toContainText('Long above value');
  await expect(tt.getByText('BLOCKED').first()).toBeVisible();
  expect(errors).toEqual([]);
});
