import { expect, test, type Page } from '@playwright/test';

// Native AI stream mocked (web build): window.__HTFLOW_AI_MOCK__ streams tokens / tool calls like
// the Rust `ai_chat` channel does, and records every request in window.__HTFLOW_AI_LOG__.
async function createAccount(page: Page, username: string, script: object) {
  await page.addInitScript((s) => {
    (window as unknown as { __HTFLOW_AI_MOCK__: object }).__HTFLOW_AI_MOCK__ = s;
  }, script);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('AI Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('AI: chat with screenshot consent + read tool, agent run, audit, kill switch', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'ai1', {
    toolCalls: [{ name: 'get_market_data', arguments: {} }],
    tokenMs: 5,
  });
  await page.getByTestId('ribbon-ai').click();
  const win = page.getByTestId('ai-window');
  await expect(win).toBeVisible();

  // Screenshot: chip shows it will be attached; "always ask" shows a confirmation first.
  await win.getByTestId('ai-shot-toggle').click();
  await expect(win.getByTestId('ai-shot-chip')).toContainText('Screenshot will be attached');
  await win.getByTestId('ai-input').fill('What is on my chart?');
  await win.getByTestId('ai-send').click();
  await page.getByRole('button', { name: 'Send screenshot' }).click();

  await expect(win.getByTestId('ai-tool-msg')).toContainText('get_market_data');
  await expect(win.getByTestId('ai-msg-assistant').last()).toContainText('Tool results received');
  await expect(win.getByTestId('ai-msg-user')).toContainText('screenshot sent');
  const sent = await page.evaluate(() => {
    const log = (
      window as unknown as {
        __HTFLOW_AI_LOG__: {
          requests: {
            messages: { parts: { type: string; text?: string }[] }[];
            tools: unknown[];
          }[];
        };
      }
    ).__HTFLOW_AI_LOG__;
    const first = log.requests[0]!;
    return {
      image: first.messages[0]!.parts.some((p) => p.type === 'image'),
      context: first.messages[0]!.parts.some((p) => p.text?.includes('<screen_context>')),
      tools: first.tools.length,
    };
  });
  expect(sent).toEqual({ image: true, context: true, tools: 5 });

  // Regenerate replays the last user turn.
  await win.getByTestId('ai-regenerate').click();
  await expect(win.getByTestId('ai-msg-assistant').last()).toContainText('Tool results received');

  // Agent: start (paper), a scheduled run calls tools; audit records them; kill switch stops it.
  await win.getByRole('tab', { name: 'Agent' }).click();
  await win.getByTestId('ai-agent-start').click();
  await expect(win.getByText('Agent running')).toBeVisible();
  await win.getByTestId('ai-kill').click();
  await expect(win.getByText('Kill switch on')).toBeVisible();
  await expect(win.getByText('Agent stopped')).toBeVisible();
  await expect(win.getByTestId('ai-agent-start')).toBeVisible();

  await win.getByRole('tab', { name: 'Audit log' }).click();
  await expect(win.getByTestId('ai-audit-row').first()).toBeVisible();
  await expect(win.getByTestId('ai-audit')).toContainText('kill_switch');
  await expect(win.getByTestId('ai-audit')).toContainText('get_market_data');

  // Providers: keys go to the vault; base URLs are checked against the allow-list.
  await win.getByRole('tab', { name: 'Providers' }).click();
  const openai = win.getByTestId('ai-provider-openai');
  await openai.getByLabel('OpenAI ChatGPT base URL').fill('https://evil.example.com/v1');
  await expect(openai).toContainText('Only https://api.openai.com');
  await openai.getByLabel('OpenAI ChatGPT API key').fill('sk-test-000000000000000000');
  await openai.getByRole('button', { name: 'Save key' }).click();
  await expect(openai).toContainText('key saved');

  // Command palette entries.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('AI: Kill');
  await expect(page.getByText('AI: Kill switch (stop agent, block AI orders)')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('AI: stop a streaming reply', async ({ page }) => {
  await createAccount(page, 'ai2', {
    reply: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    tokenMs: 250,
  });
  await page.getByTestId('ribbon-ai').click();
  const win = page.getByTestId('ai-window');
  await win.getByTestId('ai-input').fill('stream please');
  await win.getByTestId('ai-send').click();
  await expect(win.getByTestId('ai-stop')).toBeVisible();
  await win.getByTestId('ai-stop').click();
  await expect(win.getByTestId('ai-send')).toBeVisible();
  const text = await win.getByTestId('ai-msg-assistant').last().innerText();
  expect(text).not.toContain('fourteen');
});
