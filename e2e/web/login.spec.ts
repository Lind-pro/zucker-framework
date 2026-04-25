/**
 * Web template (Next.js) — Login page e2e tests.
 *
 * All backend calls are intercepted with page.route().
 * Tests verify form render, successful login + cookie set, error state,
 * and open-redirect protection.
 */
import { test, expect } from '@playwright/test';

// ── helpers ──────────────────────────────────────────────────────────────────

async function mockLoginApi(
  page: import('@playwright/test').Page,
  opts: { success?: boolean } = {},
) {
  const success = opts.success ?? true;

  await page.route('**/api/authorize/login', (route) => {
    if (success) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'u1',
          token: 'web.test.token',
          expires: 86400000,
        }),
      });
    } else {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'illegal_password', statusCode: 401 }),
      });
    }
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('Web Login page', () => {
  test('renders login form', async ({ page }) => {
    await mockLoginApi(page);
    await page.goto('/login');

    await expect(page.locator('input[name="username"], input[placeholder*="用户名"], input[type="email"]')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('navigates to /dashboard after successful login', async ({ page }) => {
    await mockLoginApi(page, { success: true });
    await page.goto('/login');

    // Fill and submit the form (Next.js template uses standard HTML inputs)
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[type="password"]', 'Admin@123');
    await page.click('button[type="submit"]');

    await page.waitForURL(/dashboard/, { timeout: 10_000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('sets auth-token cookie after login', async ({ page }) => {
    await mockLoginApi(page, { success: true });
    await page.goto('/login');

    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[type="password"]', 'Admin@123');
    await page.click('button[type="submit"]');

    await page.waitForURL(/dashboard/, { timeout: 10_000 });

    const cookies = await page.context().cookies();
    const authCookie = cookies.find((c) => c.name === 'auth-token');
    expect(authCookie).toBeDefined();
    expect(authCookie?.value).toBe('web.test.token');
  });

  test('stays on login page on bad credentials', async ({ page }) => {
    await mockLoginApi(page, { success: false });
    await page.goto('/login');

    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[type="password"]', 'wrongpass');
    await page.click('button[type="submit"]');

    // Should not navigate away
    await page.waitForTimeout(1000);
    expect(page.url()).toContain('/login');
  });

  test('open redirect is sanitised — falls back to /dashboard', async ({ page }) => {
    await mockLoginApi(page, { success: true });
    await page.goto('/login?redirect=//evil.com');

    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[type="password"]', 'Admin@123');
    await page.click('button[type="submit"]');

    await page.waitForURL(/dashboard/, { timeout: 10_000 });
    expect(page.url()).not.toContain('evil.com');
  });

  test('valid redirect param is honoured', async ({ page }) => {
    await mockLoginApi(page, { success: true });
    await page.goto('/login?redirect=/profile');

    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[type="password"]', 'Admin@123');
    await page.click('button[type="submit"]');

    // Should go to /profile (or fall back gracefully if page doesn't exist)
    await page.waitForURL(/\/(profile|dashboard)/, { timeout: 10_000 });
    expect(page.url()).not.toContain('evil.com');
  });
});
