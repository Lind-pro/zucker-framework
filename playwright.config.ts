import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e configuration.
 *
 * Targets:
 * - admin  (Vite React SPA)  → http://localhost:4201 (templates/admin vite.config.ts)
 * - web    (Next.js)         → http://localhost:4202 (templates/web `next dev -p 4202`)
 *
 * Both dev servers are started automatically by Playwright before the test run.
 * The backend API is mocked via page.route() inside each spec — no real server
 * is required for UI tests.
 */
/**
 * Launch marketing pages (e2e/web/launch-marketing.spec.ts) need a PRODUCTION web build whose
 * server-side reads go to the in-test stub API (e2e/web/launch-stub-api.ts, started by the spec on
 * E2E_STUB_API_PORT). The web server is only port-checked at start, so nothing is rendered before the
 * stub listens. Synthetic secret; override any value through the environment.
 */
/**
 * Dev-server ports (defaults match the templates). Override when those ports are taken on the host,
 * for example E2E_ADMIN_PORT=4501 E2E_WEB_DEV_PORT=4502; an occupied default port is otherwise reused.
 */
const ADMIN_PORT = Number(process.env['E2E_ADMIN_PORT'] ?? 4201);
const WEB_DEV_PORT = Number(process.env['E2E_WEB_DEV_PORT'] ?? 4202);
const LAUNCH_WEB_PORT = Number(process.env['E2E_LAUNCH_WEB_PORT'] ?? 4391);
process.env['E2E_WEB_URL'] ??= `http://127.0.0.1:${LAUNCH_WEB_PORT}`;
process.env['E2E_STUB_API_PORT'] ??= '4393';
process.env['E2E_REVALIDATE_SECRET'] ??= 'synthetic-e2e-revalidate-secret-0123456789abcdef';

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
        baseURL: `http://localhost:${ADMIN_PORT}`,
      },
    },
    {
      name: 'web-chromium',
      testMatch: 'e2e/web/**/*.spec.ts',
      testIgnore: 'e2e/web/launch-marketing.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${WEB_DEV_PORT}`,
      },
    },
    {
      name: 'web-launch-chromium',
      testMatch: 'e2e/web/launch-marketing.spec.ts',
      // The spec sets its own baseURL from E2E_WEB_URL and runs serially against one stub.
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: `pnpm --filter @zucker-framework/template-admin exec vite --port ${ADMIN_PORT} --strictPort`,
      url: `http://localhost:${ADMIN_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @zucker-framework/template-web exec next dev -p ${WEB_DEV_PORT}`,
      url: `http://localhost:${WEB_DEV_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @zucker-framework/template-web build && pnpm --filter @zucker-framework/template-web exec next start -H 127.0.0.1 -p ${LAUNCH_WEB_PORT}`,
      port: LAUNCH_WEB_PORT,
      reuseExistingServer: false,
      timeout: 600_000,
      env: {
        API_URL: `http://127.0.0.1:${process.env['E2E_STUB_API_PORT']}/api`,
        SITE_URL: process.env['E2E_WEB_URL']!,
        DEFAULT_LOCALE: 'en',
        REVALIDATE_SECRET: process.env['E2E_REVALIDATE_SECRET']!,
      },
    },
  ],
});
