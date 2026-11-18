import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('News Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByTestId('recovery-code').locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

/** Stands in for the Rust commands (feed_fetch, feed_allow_*, calendar_fetch). */
async function mockNative(page: Page, calendarFails = false) {
  await page.addInitScript((fail) => {
    (window as unknown as Record<string, unknown>).__htflowNative = {
      feed_allow_add: (a: { url: string }) => new URL(a.url).hostname,
      feed_allow_remove: () => undefined,
      feed_allow_list: () => ({
        defaults: [],
        custom: ['my.blog.example'],
        calendarHost: '',
        calendarUrl: '',
      }),
      feed_fetch: (a: { url: string }) => ({
        title: 'Mock',
        fetchedAt: Date.now(),
        fromCache: false,
        stale: false,
        items: [
          {
            guid: `g-${a.url}`,
            link: 'https://example.com/story',
            title: `Real headline from ${new URL(a.url).hostname}`,
            summary: 'Bitcoin and BTC react to the FOMC rate decision.',
            published: Date.now() - 600_000,
            categories: [],
          },
        ],
      }),
      calendar_fetch: () => {
        if (fail) throw new Error('Could not connect');
        const t = Date.now() + 3 * 3_600_000;
        return {
          fetchedAt: Date.now(),
          fromCache: false,
          stale: false,
          sourceUrl: '',
          events: [
            {
              t,
              currency: 'USD',
              title: 'Core CPI m/m',
              impact: 'high',
              forecast: '0.3%',
              previous: '0.2%',
            },
          ],
        };
      },
    };
  }, calendarFails);
}

test('News, RSS and Calendar show real (mocked native) data without sample labels', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockNative(page);
  await createAccount(page, 'newsreal1');

  await page.getByTestId('ribbon-rss').click();
  const rss = page.getByTestId('rss-reader');
  await expect(rss.getByText(/Real headline from cointelegraph.com/).first()).toBeVisible();
  await expect(rss.getByText('Offline sample shown')).toHaveCount(0);
  await expect(rss.getByText(/\(sample\)/)).toHaveCount(0);
  await rss
    .getByText(/Real headline from www.sec.gov/)
    .first()
    .click();
  await expect(rss.getByRole('button', { name: 'Open in browser' })).toBeEnabled();
  await rss.getByRole('button', { name: 'Mark all read' }).click();
  await expect(rss.getByRole('button', { name: 'Mark all read' })).toBeDisabled();

  await page.getByTestId('ribbon-calendar').click();
  const cal = page.getByTestId('economic-calendar');
  await expect(cal.getByText('Core CPI m/m')).toBeVisible();
  await expect(cal.getByTestId('calendar-status')).toContainText('Updated');
  await expect(cal.getByText(/sample/i)).toHaveCount(0);

  await page.getByTestId('ribbon-news').click();
  const news = page.getByTestId('news-window');
  await expect(news.locator('.news-row').first()).toBeVisible();
  await expect(news.getByText(/offline sample/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Calendar shows an error state and a labelled sample only as last resort', async ({
  page,
}) => {
  await mockNative(page, true);
  await createAccount(page, 'newsreal2');
  await page.getByTestId('ribbon-calendar').click();
  const cal = page.getByTestId('economic-calendar');
  await expect(cal.getByTestId('calendar-status')).toContainText('Calendar unavailable');
  await expect(cal.getByText(/OFFLINE SAMPLE events shown/)).toBeVisible();
});
