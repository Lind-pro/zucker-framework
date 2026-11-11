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

/** Access tokens are JWTs naming the account and session (sub + sid), as the session guard requires. */
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const ACCESS = `${b64({ alg: 'none' })}.${b64({ sub: 'u1', sid: 's1' })}.sig`;

async function mockAll(page: import('@playwright/test').Page) {
  // Auth
  await page.route('**/api/authorize/login', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ userId: 'u1', token: ACCESS, expires: 7200000 }) }),
  );
  // A page load (the /users navigation below) restores the session through one cookie refresh.
  await page.route('**/api/authorize/refresh', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: ACCESS }) }),
  );
  await page.route('**/api/menu/tree', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/authorize/me', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id: 'u1', username: 'admin', name: '超级管理员',
        permissions: [{ id: 'users', name: '用户', actions: ['query','add','update','delete'] }],
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
      r.fallback();
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
      r.fallback();
    }
  });
}

/** Log in and navigate to /users. */
async function goToUsers(page: import('@playwright/test').Page) {
  await mockAll(page);
  await page.goto('/login');
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('Admin@123');
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
    for (const username of ['admin', 'alice', 'bob']) {
      await expect(page.getByRole('cell', { name: username, exact: true })).toBeVisible();
    }
  });

  test('opens create dialog when "新建用户" button is clicked', async ({ page }) => {
    await goToUsers(page);

    const addBtn = page.getByRole('button', { name: '新建用户' });
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    await addBtn.click();

    // A modal/drawer should appear with a form
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('shows delete confirmation dialog', async ({ page }) => {
    await goToUsers(page);

    // Click the first delete button in the table
    const deleteBtn = page.getByRole('button', { name: '删除', exact: true }).first();
    await deleteBtn.click();

    // Confirmation dialog before the record is deleted
    await expect(page.getByText('确定删除这条记录？')).toBeVisible({ timeout: 5_000 });
  });
});
