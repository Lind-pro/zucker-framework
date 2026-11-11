import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

/**
 * Playwright e2e configuration: one project per server shape, each with its own server(s).
 *
 * | project                   | specs                              | server                                                          |
 * |---------------------------|------------------------------------|-----------------------------------------------------------------|
 * | admin-chromium            | e2e/admin/**                       | Vite dev server of templates/admin                              |
 * | web-chromium              | e2e/web/** (browser-mocked API)    | production web build, API_URL → e2e/web/mock-api-server.mjs     |
 * | web-affonso-chromium      | billing.spec referral checkout     | the same build, started with the Affonso site-connection env    |
 * | web-launch-chromium       | launch-marketing.spec              | production build, API_URL → launch-stub-api.ts (spec-started)   |
 * | web-integrations-chromium | site-integrations.spec             | production build, API_URL → the spec's public-settings fixture  |
 *
 * `next build` bakes API_URL into the rewrites, so every API target gets its own build directory
 * (`NEXT_DIST_DIR`, read by templates/web/next.config.ts). Only the servers of the selected projects
 * start (`--project`); with no `--project` every server starts.
 *
 * Ports are env-configurable and default to the 45xx range. They must never default to ports used by
 * other services on a shared host (4200-4202, 4103, 4104, 4281): the web template's own fallback
 * API_URL is http://localhost:4200/api, so every web server here sets API_URL explicitly.
 */
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port number`);
  if ([4103, 4104, 4200, 4201, 4202, 4281].includes(value)) throw new Error(`${name}=${value} is reserved on this host; choose another port`);
  return value;
};
const ADMIN_PORT = port('E2E_ADMIN_PORT', 4501);
const WEB_PORT = port('E2E_WEB_PORT', 4502);
const MOCK_API_PORT = port('E2E_MOCK_API_PORT', 4509);
const AFFONSO_WEB_PORT = port('E2E_AFFONSO_WEB_PORT', 4512);
const LAUNCH_WEB_PORT = port('E2E_LAUNCH_WEB_PORT', 4521);
const INTEGRATIONS_WEB_PORT = port('E2E_INTEGRATIONS_WEB_PORT', 4531);

// Values the specs read from their own process (they must match the servers below).
process.env['E2E_WEB_URL'] ??= `http://127.0.0.1:${LAUNCH_WEB_PORT}`;
process.env['E2E_STUB_API_PORT'] ??= String(port('E2E_STUB_API_PORT', 4523));
process.env['SITE_INTEGRATIONS_FIXTURE_PORT'] ??= String(port('SITE_INTEGRATIONS_FIXTURE_PORT', 4533));
process.env['E2E_SITE_URL'] ??= `http://localhost:${WEB_PORT}`;
process.env['E2E_WEB_PRODUCTION'] ??= '1';
process.env['E2E_REVALIDATE_SECRET'] ??= 'synthetic-e2e-revalidate-secret-0123456789abcdef';
const AFFONSO_ENV = {
  SITE_CONFIGURATION_SOURCE: 'environment',
  SITE_CONNECTIONS_ENABLED: 'true',
  AFFONSO_ENABLED: 'true',
  AFFONSO_PROGRAM_ID: 'synthetic-program',
  AFFONSO_COOKIE_DURATION_DAYS: '30',
};
/** Explicit site-connection settings, so the Affonso values never reach the other web servers. */
const NO_SITE_ENV = { SITE_CONFIGURATION_SOURCE: 'server', SITE_CONNECTIONS_ENABLED: 'false', AFFONSO_ENABLED: 'false' };
const AFFONSO_TEST = /send only server selections and supported referral/;

const web = 'pnpm --filter @zucker-framework/template-web';
/** Production build into its own directory, then `next start` on 127.0.0.1. */
const buildAndStart = (distDir: string, webPort: number, skipBuild = false) => {
  const start = `NEXT_DIST_DIR=${distDir} ${web} exec next start -H 127.0.0.1 -p ${webPort}`;
  return skipBuild ? start : `NEXT_DIST_DIR=${distDir} ${web} build && ${start}`;
};
const webEnv = (apiPort: number, siteUrl: string, extra: Record<string, string> = {}) => ({
  API_URL: `http://127.0.0.1:${apiPort}/api`,
  SITE_URL: siteUrl,
  DEFAULT_LOCALE: 'en',
  REVALIDATE_SECRET: process.env['E2E_REVALIDATE_SECRET']!,
  ...extra,
});

type WebServer = NonNullable<Extract<PlaywrightTestConfig['webServer'], unknown[]>>[number];
/** Server-side API of web-chromium and web-affonso-chromium. */
const mockApi: WebServer = {
  command: `node e2e/web/mock-api-server.mjs ${MOCK_API_PORT}`,
  url: `http://127.0.0.1:${MOCK_API_PORT}/health`,
  reuseExistingServer: false,
  timeout: 10_000,
};
const servers: Record<string, WebServer[]> = {
  'admin-chromium': [{
    command: `pnpm --filter @zucker-framework/template-admin exec vite --port ${ADMIN_PORT} --strictPort`,
    url: `http://localhost:${ADMIN_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  }],
  'web-chromium': [{
    command: buildAndStart('.next-e2e-web', WEB_PORT),
    port: WEB_PORT,
    reuseExistingServer: false,
    timeout: 600_000,
    env: webEnv(MOCK_API_PORT, `http://localhost:${WEB_PORT}`, NO_SITE_ENV),
  }],
  'web-affonso-chromium': [{
    // Same API target as web-chromium; site connections are read at request time, so its build is reused
    // when web-chromium starts first in the same run.
    command: buildAndStart('.next-e2e-web', AFFONSO_WEB_PORT),
    port: AFFONSO_WEB_PORT,
    reuseExistingServer: false,
    timeout: 600_000,
    env: webEnv(MOCK_API_PORT, `http://localhost:${AFFONSO_WEB_PORT}`, AFFONSO_ENV),
  }],
  'web-launch-chromium': [{
    command: buildAndStart('.next-e2e-launch', LAUNCH_WEB_PORT),
    port: LAUNCH_WEB_PORT,
    reuseExistingServer: false,
    timeout: 600_000,
    env: webEnv(Number(process.env['E2E_STUB_API_PORT']), process.env['E2E_WEB_URL']!, NO_SITE_ENV),
  }],
  'web-integrations-chromium': [{
    command: buildAndStart('.next-e2e-integrations', INTEGRATIONS_WEB_PORT),
    port: INTEGRATIONS_WEB_PORT,
    reuseExistingServer: false,
    timeout: 600_000,
    env: webEnv(Number(process.env['SITE_INTEGRATIONS_FIXTURE_PORT']), `http://localhost:${INTEGRATIONS_WEB_PORT}`, NO_SITE_ENV),
  }],
};

/** Projects named on the command line (`--project a`, `--project=a,b`); empty means all. */
function selectedProjects(argv = process.argv): string[] {
  const names: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === '--project' && argv[index + 1]) names.push(...argv[index + 1]!.split(','));
    else if (arg.startsWith('--project=')) names.push(...arg.slice('--project='.length).split(','));
  });
  return names;
}
const selected = selectedProjects();
const shared = selected.length ? selected : Object.keys(servers);
const webServer = [
  ...(shared.includes('web-chromium') || shared.includes('web-affonso-chromium') ? [mockApi] : []),
  ...Object.entries(servers).filter(([name]) => shared.includes(name)).flatMap(([, list]) => list),
];
// web-affonso reuses the web-chromium build: build it only when web-chromium is not also starting.
if (shared.includes('web-affonso-chromium') && !shared.includes('web-chromium')) {
  servers['web-affonso-chromium']![0]!.command = buildAndStart('.next-e2e-web', AFFONSO_WEB_PORT);
} else if (shared.includes('web-affonso-chromium')) {
  servers['web-affonso-chromium']![0]!.command = buildAndStart('.next-e2e-web', AFFONSO_WEB_PORT, true);
}
if (shared.includes('web-integrations-chromium')) process.env['RUN_SITE_INTEGRATIONS_BROWSER'] ??= '1';
if (shared.includes('web-affonso-chromium')) for (const [key, value] of Object.entries(AFFONSO_ENV)) process.env[key] ??= value;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],

  use: {
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'admin-chromium',
      testMatch: 'admin/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${ADMIN_PORT}`,
        // The admin default locale is en (D7); these specs assert zh-CN copy, so they choose it explicitly.
        storageState: { cookies: [], origins: [{ origin: `http://localhost:${ADMIN_PORT}`, localStorage: [{ name: 'zucker-admin-locale', value: 'zh-CN' }] }] },
      },
    },
    {
      name: 'web-chromium',
      testMatch: 'web/**/*.spec.ts',
      testIgnore: ['web/launch-marketing.spec.ts', 'web/site-integrations.spec.ts'],
      grepInvert: AFFONSO_TEST,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${WEB_PORT}` },
    },
    {
      name: 'web-affonso-chromium',
      testMatch: 'web/billing.spec.ts',
      grep: AFFONSO_TEST,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${AFFONSO_WEB_PORT}` },
    },
    {
      name: 'web-launch-chromium',
      testMatch: 'web/launch-marketing.spec.ts',
      // The spec sets its own baseURL from E2E_WEB_URL and runs serially against one stub.
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'web-integrations-chromium',
      testMatch: 'web/site-integrations.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${INTEGRATIONS_WEB_PORT}` },
    },
  ],

  webServer,
});
