import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack AI acceptance (e2e/stack): a production Web build (`next build && next start`) in front
 * of the real Server (AppModule, PostgreSQL, Redis) started with `AI_TEST_FAKE_PROVIDERS=true`, so no
 * paid provider is called. Nothing is mocked in the browser. The stack is started outside Playwright
 * (see docs/ai-quickstart.md, "Test without paid providers"); point the run at it with
 * E2E_STACK_WEB_URL (default http://127.0.0.1:4492). Not part of the default `playwright test` run.
 */
export default defineConfig({
  testDir: './e2e/stack',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['E2E_STACK_WEB_URL'] ?? 'http://127.0.0.1:4492',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
