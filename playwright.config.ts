import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e configuration.
 *
 * Targets:
 * - admin  (Vite React SPA)  → http://localhost:3100
 * - web    (Next.js)         → http://localhost:4101
 *
 * Both dev servers are started automatically by Playwright before the test run.
 * The backend API is mocked via page.route() inside each spec — no real server
 * is required for UI tests.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: [['html', { outputFolder: 'playwright-report' }]],

  use: {
    // Capture screenshot and trace on failure
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'admin-chromium',
      testMatch: 'e2e/admin/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3100',
      },
    },
    {
      name: 'web-chromium',
      testMatch: 'e2e/web/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4101',
      },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @zucker-framework/template-admin dev',
      url: 'http://localhost:3100',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @zucker-framework/template-web dev',
      url: 'http://localhost:4101',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],
});
