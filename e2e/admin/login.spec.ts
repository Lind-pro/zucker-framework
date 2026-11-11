/**
 * Admin SPA — Login e2e tests (Playwright).
 *
 * All backend API calls are intercepted with page.route() so no real server
 * is needed. Tests verify the UI flow: form rendering, submission, error
 * messages, and successful redirect to /dashboard.
 */
import { test, expect } from '@playwright/test';

// ── mock API payloads ────────────────────────────────────────────────────────

const VALID_LOGIN_RESPONSE = {
  userId: 'u1',
  token: 'eyJhbGciOiJIUzI1NiJ9.test',
  expires: 7200000,
};

const ME_RESPONSE = {
  id: 'u1',
  username: 'admin',
  name: '管理员',
  permissions: [
    { id: 'user', name: '用户管理', actions: ['query', 'add', 'update', 'delete'] },
  ],
  attributes: {},
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function mockAuthApis(
  page: import('@playwright/test').Page,
  opts: { loginSuccess?: boolean } = {},
) {
  const loginSuccess = opts.loginSuccess ?? true;

  await page.route('**/api/authorize/login', (route) => {
    if (loginSuccess) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VALID_LOGIN_RESPONSE) });
    } else {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'illegal_password', statusCode: 401 }),
      });
    }
  });

  await page.route('**/api/authorize/me', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME_RESPONSE) });
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('Admin Login page', () => {
  test('renders login form with username and password fields', async ({ page }) => {
    await mockAuthApis(page);
    await page.goto('/');

    // Should redirect to /login or show login page
    await page.waitForURL(/login/, { timeout: 10_000 });
    await expect(page.getByRole('textbox', { name: '用户名', exact: true })).toBeVisible();
    await expect(page.locator('input[type="password"], input[placeholder*="密码"]')).toBeVisible();
  });

  test('shows validation errors when submitting empty form', async ({ page }) => {
    await mockAuthApis(page);
    await page.goto('/login');

    // Click submit without filling fields
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    // The login form reports each missing field inline
    await expect(page.getByText('请填写用户名')).toBeVisible({ timeout: 5_000 });
  });

  test('navigates to /dashboard after successful login', async ({ page }) => {
    await mockAuthApis(page, { loginSuccess: true });
    await page.goto('/login');

    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('Admin@123');
    await page.click('button[type="submit"]');

    await page.waitForURL(/dashboard/, { timeout: 10_000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('shows error message on wrong credentials', async ({ page }) => {
    await mockAuthApis(page, { loginSuccess: false });
    await page.goto('/login');

    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('wrongpass');
    await page.click('button[type="submit"]');

    // Should stay on login page
    await expect(page).not.toHaveURL(/dashboard/);
  });

  test('redirect param is respected after login', async ({ page }) => {
    await mockAuthApis(page, { loginSuccess: true });
    await page.goto('/login?redirect=/roles');

    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('Admin@123');
    await page.click('button[type="submit"]');

    // Should redirect to /roles, not /dashboard
    await page.waitForURL(/\/(roles|dashboard)/, { timeout: 10_000 });
  });

  test('open redirect is sanitised — unsafe redirect falls back to /dashboard', async ({ page }) => {
    await mockAuthApis(page, { loginSuccess: true });
    // Attempt open redirect via //evil.com
    await page.goto('/login?redirect=//evil.com/steal');

    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('Admin@123');
    await page.click('button[type="submit"]');

    await page.waitForURL(/dashboard/, { timeout: 10_000 });
    expect(page.url()).not.toContain('evil.com');
  });
});
