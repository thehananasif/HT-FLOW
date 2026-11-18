import { defineConfig, devices } from '@playwright/test';

// `pnpm guide:screenshots` — regenerates docs/user-guide/images/*.webp and the generated
// shortcut table. Not part of `pnpm e2e` (see playwright.config.ts testIgnore).
const port = Number(process.env.E2E_PORT ?? 1420);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'guide-screenshots.spec.ts',
  timeout: 600_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    actionTimeout: 15_000,
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 } }],
  webServer: {
    command: `pnpm dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
