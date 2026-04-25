/**
 * Admin SPA — User management page e2e tests.
 *
 * Mocks:
 * - POST /api/authorize/login
 * - GET  /api/authorize/me
 * - POST /api/users/_query  (paginated list)
 * - POST /api/users         (create)
 * - PUT  /api/users/:id     (update)
 * - DELETE /api/users/:id   (delete)
 */
import { test, expect } from '@playwright/test';

// ── fixtures ──────────────────────────────────────────────────────────────────

const USERS = [
  { id: 'u1', username: 'admin', name: '超级管理员', status: 1, createTime: 1700000000000 },
  { id: 'u2', username: 'alice', name: 'Alice',     status: 1, createTime: 1700001000000 },
  { id: 'u3', username: 'bob',   name: 'Bob',       status: 0, createTime: 1700002000000 },
];

async function mockAll(page: import('@playwright/test').Page) {
  // Auth
  await page.route('**/api/authorize/login', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ userId: 'u1', token: 'tok.test', expires: 7200000 }) }),
  );
  await page.route('**/api/authorize/me', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id: 'u1', username: 'admin', name: '超级管理员',
        permissions: [{ id: 'user', name: '用户', actions: ['query','add','update','delete'] }],
      }) }),
  );

  // User list query
  await page.route('**/api/users/_query', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: USERS, total: USERS.length }) }),
  );

  // Create user
  await page.route('**/api/users', (r) => {
    if (r.request().method() === 'POST') {
      r.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ id: 'u4', username: 'newuser', name: 'New User', status: 1 }) });
    } else {
      r.continue();
    }
  });

  // Update / Delete by id
  await page.route('**/api/users/**', (r) => {
    const method = r.request().method();
    if (method === 'PUT') {
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else if (method === 'DELETE') {
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      r.continue();
    }
  });
}

/** Log in and navigate to /users. */
async function goToUsers(page: import('@playwright/test').Page) {
  await mockAll(page);
  await page.goto('/login');
  await page.fill('input[placeholder*="用户名"]', 'admin');
  await page.fill('input[placeholder*="密码"]', 'Admin@123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 10_000 });
  await page.goto('/users');
  await page.waitForLoadState('networkidle');
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('User management page', () => {
  test('displays paginated user list', async ({ page }) => {
    await goToUsers(page);

    // ProTable renders rows
    await expect(page.locator('table')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('text=admin')).toBeVisible();
    await expect(page.locator('text=alice')).toBeVisible();
    await expect(page.locator('text=bob')).toBeVisible();
  });

  test('opens create dialog when "新增" button is clicked', async ({ page }) => {
    await goToUsers(page);

    const addBtn = page.locator('button', { hasText: '新增' });
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    await addBtn.click();

    // A modal/drawer should appear with a form
    await expect(page.locator('[role="dialog"], .ant-modal')).toBeVisible({ timeout: 5_000 });
  });

  test('shows delete confirmation dialog', async ({ page }) => {
    await goToUsers(page);

    // Click the first delete button in the table
    const deleteBtn = page.locator('button', { hasText: '删除' }).first();
    await deleteBtn.click();

    // Ant Design Popconfirm or Modal.confirm
    await expect(page.locator('text=确定, text=确认')).toBeVisible({ timeout: 5_000 });
  });
});
