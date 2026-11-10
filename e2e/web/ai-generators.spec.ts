import { test, expect } from '@playwright/test';
import { catalog, installApi, task, waitForHydratedAccount } from './ai-fixtures';

const KEY_RULE = /^[A-Za-z0-9_.:-]{8,128}$/;

test.describe('AI generator /ai/image', () => {
  async function open(page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext, baseURL: string | undefined, tasks: unknown[] = []) {
    const api = await installApi(page, context, baseURL, {
      'GET /api/ai/catalog': () => ({ result: catalog() }),
      'GET /api/ai/tasks': () => ({ result: { items: tasks, next: null } }),
    });
    await page.goto('/ai/image');
    await expect(page.getByRole('heading', { name: 'AI image generator' })).toBeVisible();
    await waitForHydratedAccount(page);
    return api;
  }
  const submit = async (page: import('@playwright/test').Page, prompt?: string) => {
    if (prompt !== undefined) await page.getByLabel('Prompt', { exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
  };

  test('reuses the Idempotency-Key after a network error and after a 5xx, then clears it on success', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    let attempt = 0;
    api.on('POST /api/ai/tasks', () => {
      attempt += 1;
      if (attempt === 1) return { abort: true };
      if (attempt === 2) return { status: 503, result: null };
      return { status: 202, result: task({ id: 'task-ok' }) };
    });
    await submit(page, 'a red fox');
    await expect(page.getByText('We could not confirm the submission')).toBeVisible();
    await submit(page);
    await expect(page.getByText('This model is not available right now')).toBeVisible();
    await submit(page);
    await expect(page.locator('[data-task-id="task-ok"]')).toBeVisible();

    const posts = api.callsTo('POST /api/ai/tasks');
    expect(posts).toHaveLength(3);
    const keys = posts.map((call) => call.headers['idempotency-key']);
    expect(keys[0]).toMatch(KEY_RULE);
    expect(new Set(keys).size).toBe(1);
    // identical body for every retry (a changed body would be rejected by the server for a reused key)
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(posts[2]!.body).toEqual(posts[0]!.body);
    expect(posts[0]!.body).toMatchObject({ kind: 'image', providerId: 'ai-fake', model: 'img-a', prompt: 'a red fox', cost: 5, options: { count: 1, width: 1024, height: 1024 } });

    // the next, separate generation gets a new key
    api.on('POST /api/ai/tasks', () => ({ status: 202, result: task({ id: 'task-2' }) }));
    await submit(page, 'a blue fox');
    await expect(page.locator('[data-task-id="task-2"]')).toBeVisible();
    expect(api.callsTo('POST /api/ai/tasks').at(-1)!.headers['idempotency-key']).not.toBe(keys[0]);
    expect(api.unhandled.filter((entry) => !entry.startsWith('GET /api/ai/tasks/'))).toEqual([]);
  });

  test('changing the request after an uncertain failure uses a new key', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    let attempt = 0;
    api.on('POST /api/ai/tasks', () => (++attempt === 1 ? { abort: true } : { status: 202, result: task() }));
    await submit(page, 'first prompt');
    await expect(page.getByText('We could not confirm the submission')).toBeVisible();
    await submit(page, 'second prompt');
    await expect(page.locator('[data-task-id="task-1"]')).toBeVisible();
    const [first, second] = api.callsTo('POST /api/ai/tasks').map((call) => call.headers['idempotency-key']);
    expect(first).not.toBe(second);
  });

  test('replaces the key after a definite 4xx rejection', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    let attempt = 0;
    api.on('POST /api/ai/tasks', () => (++attempt === 1 ? { status: 400, code: 'AI_TASK_INVALID', result: null } : { status: 202, result: task() }));
    await submit(page, 'same prompt');
    await expect(page.getByText('Some settings are not accepted')).toBeVisible();
    await submit(page);
    await expect(page.locator('[data-task-id="task-1"]')).toBeVisible();
    const keys = api.callsTo('POST /api/ai/tasks').map((call) => call.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('402 shows the credits notice with a pricing link and no task is added', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    api.on('POST /api/ai/tasks', () => ({ status: 402, code: 'AI_TASK_INSUFFICIENT_CREDITS', result: null }));
    await submit(page, 'costly');
    const alert = page.getByRole('alert').filter({ hasText: 'You do not have enough credits' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('link', { name: 'Get credits' })).toHaveAttribute('href', /pricing/);
    await expect(page.locator('[data-task-id]')).toHaveCount(0);
  });

  test('409 cost-changed reloads the catalog and quotes the new price', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    await expect(page.getByTestId('ai-cost')).toContainText('Cost: 5 credits');
    const before = api.count('GET /api/ai/catalog');
    api.on('GET /api/ai/catalog', () => ({
      result: catalog({ image: [{ providerId: 'ai-fake', model: 'img-a', label: 'Fake Image A', cost: 8, available: true }, { providerId: 'ai-fake', model: 'img-b', label: 'Fake Image B', cost: 9, available: true }] }),
    }));
    api.on('POST /api/ai/tasks', () => ({ status: 409, code: 'AI_TASK_COST_CHANGED', result: null }));
    await submit(page, 'price check');
    await expect(page.getByText('The price just changed')).toBeVisible();
    await expect(page.getByTestId('ai-cost')).toContainText('Cost: 8 credits');
    expect(api.count('GET /api/ai/catalog')).toBe(before + 1);
    // resubmitting quotes the new cost
    api.on('POST /api/ai/tasks', () => ({ status: 202, result: task({ cost: 8 }) }));
    await submit(page);
    await expect.poll(() => api.callsTo('POST /api/ai/tasks').length).toBe(2);
    expect(api.callsTo('POST /api/ai/tasks')[1]!.body).toMatchObject({ cost: 8 });
    expect(api.callsTo('POST /api/ai/tasks')[1]!.headers['idempotency-key']).not.toBe(api.callsTo('POST /api/ai/tasks')[0]!.headers['idempotency-key']);
  });

  test('409 model-not-offered also reloads the catalog', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL);
    const before = api.count('GET /api/ai/catalog');
    api.on('POST /api/ai/tasks', () => ({ status: 400, code: 'AI_MODEL_NOT_OFFERED', result: null }));
    await submit(page, 'x');
    await expect(page.getByText('This model is no longer offered')).toBeVisible();
    expect(api.count('GET /api/ai/catalog')).toBe(before + 1);
  });

  test('cancel posts once, shows the cancelled state and the refund note', async ({ page, context, baseURL }) => {
    const running = task({ id: 'task-c', status: 'PROCESSING', progress: 30 });
    const api = await open(page, context, baseURL, [running]);
    api.on('GET /api/ai/tasks/task-c', () => ({ result: running }));
    api.on('POST /api/ai/tasks/task-c/cancel', () => ({ result: task({ id: 'task-c', status: 'CANCELLED', charge: 'RELEASED', canCancel: false, completedAt: '2026-11-10T00:01:00Z' }) }));
    const card = page.locator('[data-task-id="task-c"]');
    await expect(card.getByText('30%')).toBeVisible();
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.locator('[data-status="CANCELLED"]')).toBeVisible();
    await expect(card.getByTestId('task-refunded')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(api.count('POST /api/ai/tasks/task-c/cancel')).toBe(1);
    expect(api.callsTo('POST /api/ai/tasks/task-c/cancel')[0]!.body).toEqual({});
  });

  test('cancel losing the race to completion keeps the task running and explains it', async ({ page, context, baseURL }) => {
    const running = task({ id: 'task-r', status: 'PROCESSING' });
    const api = await open(page, context, baseURL, [running]);
    api.on('GET /api/ai/tasks/task-r', () => ({ result: running }));
    api.on('POST /api/ai/tasks/task-r/cancel', () => ({ status: 409, code: 'AI_TASK_NOT_CANCELLABLE', result: null }));
    const card = page.locator('[data-task-id="task-r"]');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('could not be cancelled');
    await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  });

  test('polling follows a task to completion, shows the result via a same-origin ticket, then stops', async ({ page, context, baseURL }) => {
    const queued = task({ id: 'task-p', status: 'QUEUED' });
    const api = await open(page, context, baseURL, [queued]);
    let polls = 0;
    api.on('GET /api/ai/tasks/task-p', () => {
      polls += 1;
      return { result: polls === 1 ? task({ id: 'task-p', status: 'PROCESSING', progress: 50 }) : task({ id: 'task-p', status: 'COMPLETED', charge: 'CONFIRMED', canCancel: false, outputs: [{ index: 0, contentType: 'image/png', bytes: 70 }], completedAt: '2026-11-10T00:01:00Z' }) };
    });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    api.on('GET /api/ai/tasks/task-p/outputs/0', () => ({ result: { url: '/api/files/file-1/download?token=tk1', expiresAt: '2099-01-01T00:00:00Z', expiresInSeconds: 300, contentType: 'image/png', bytes: 70 } }));
    await page.route('**/api/files/file-1/download', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    const card = page.locator('[data-task-id="task-p"]');
    await expect(card.locator('[data-status="COMPLETED"]')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('img', { name: 'Result 1' })).toBeVisible();
    const src = await card.getByRole('img', { name: 'Result 1' }).getAttribute('src');
    expect(src).toMatch(/^blob:/);
    expect(polls).toBe(2);
    await page.waitForTimeout(3500);
    expect(polls).toBe(2); // terminal: the loop ended
  });

  test('polling stops for good when the task is gone (404) and says so', async ({ page, context, baseURL }) => {
    const running = task({ id: 'task-gone', status: 'PROCESSING' });
    const api = await open(page, context, baseURL, [running]);
    api.on('GET /api/ai/tasks/task-gone', () => ({ status: 404, code: 'AI_TASK_NOT_FOUND', result: null }));
    await expect(page.getByText('Status updates stopped')).toBeVisible({ timeout: 15_000 });
    const seen = api.count('GET /api/ai/tasks/task-gone');
    expect(seen).toBe(1);
    await page.waitForTimeout(5000);
    expect(api.count('GET /api/ai/tasks/task-gone')).toBe(seen);
  });

  test('polling gives up after repeated 5xx without hammering the server', async ({ page, context, baseURL }) => {
    test.setTimeout(120_000);
    const running = task({ id: 'task-5xx', status: 'PROCESSING' });
    const api = await open(page, context, baseURL, [running]);
    api.on('GET /api/ai/tasks/task-5xx', () => ({ status: 500, result: null }));
    await expect(page.getByText('Status updates stopped')).toBeVisible({ timeout: 90_000 });
    expect(api.count('GET /api/ai/tasks/task-5xx')).toBe(5);
  });

  test('leaving the page stops polling', async ({ page, context, baseURL }) => {
    const running = task({ id: 'task-l', status: 'PROCESSING' });
    const api = await open(page, context, baseURL, [running]);
    api.on('GET /api/ai/tasks/task-l', () => ({ result: running }));
    api.on('GET /api/ai/tasks', (request) => ({ result: { items: request.url.searchParams.get('kind') === 'image' ? [running] : [], next: null } }));
    await expect.poll(() => api.count('GET /api/ai/tasks/task-l'), { timeout: 10_000 }).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Video', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI video generator' })).toBeVisible();
    await page.waitForTimeout(500);
    const at = api.count('GET /api/ai/tasks/task-l');
    await page.waitForTimeout(5000);
    expect(api.count('GET /api/ai/tasks/task-l')).toBe(at);
  });

  test('insufficient balance disables Generate and offers credits; unavailable models are not selectable', async ({ page, context, baseURL }) => {
    const api = await installApi(page, context, baseURL, {
      'GET /api/ai/catalog': () => ({ result: catalog({ image: [{ providerId: 'p', model: 'down', label: 'Down', cost: 1, available: false }, { providerId: 'p', model: 'up', label: 'Up', cost: 50, available: true }] }) }),
      'GET /api/ai/tasks': () => ({ result: { items: [], next: null } }),
      'GET /api/credits/balance': () => ({ result: { available: 10 } }),
    });
    await page.goto('/ai/image');
    await waitForHydratedAccount(page);
    await expect(page.getByLabel('Model')).toHaveValue('1');
    await page.getByLabel('Prompt', { exact: true }).fill('anything');
    await expect(page.getByText('Not enough credits for this generation.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    expect(api.count('POST /api/ai/tasks')).toBe(0);
  });

  test('video and music submit their own option sets', async ({ page, context, baseURL }) => {
    const api = await installApi(page, context, baseURL, {
      'GET /api/ai/catalog': () => ({ result: catalog() }),
      'GET /api/ai/tasks': () => ({ result: { items: [], next: null } }),
      'POST /api/ai/tasks': (request) => ({ status: 202, result: task({ id: `t-${(request.body as { kind: string }).kind}`, kind: (request.body as { kind: string }).kind }) }),
    });
    await page.goto('/ai/video');
    await waitForHydratedAccount(page);
    await page.getByLabel('Prompt', { exact: true }).fill('waves');
    await page.getByLabel('Resolution').selectOption('1080p');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.locator('[data-task-id="t-video"]')).toBeVisible();
    expect(api.callsTo('POST /api/ai/tasks')[0]!.body).toMatchObject({ kind: 'video', model: 'vid-a', cost: 40, options: { duration: 5, resolution: '1080p' } });
    await page.goto('/ai/music');
    await waitForHydratedAccount(page);
    await page.getByLabel('Prompt', { exact: true }).fill('calm piano');
    await page.getByLabel('Instrumental (no vocals)').check();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.locator('[data-task-id="t-audio"]')).toBeVisible();
    const music = api.callsTo('POST /api/ai/tasks')[1]!.body as { options: Record<string, unknown>; references?: unknown };
    expect(music.options).toEqual({ duration: 30, instrumental: true });
    expect(music.references).toBeUndefined();
  });

  test('load failure offers a retry', async ({ page, context, baseURL }) => {
    let fail = true;
    await installApi(page, context, baseURL, {
      'GET /api/ai/catalog': () => (fail ? { status: 500, result: null } : { result: catalog() }),
      'GET /api/ai/tasks': () => ({ result: { items: [], next: null } }),
    });
    await page.goto('/ai/image');
    await waitForHydratedAccount(page);
    await expect(page.getByText('This page could not be loaded')).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByLabel('Prompt', { exact: true })).toBeVisible();
  });

  test('no request leaves the origin', async ({ page, context, baseURL }) => {
    const api = await open(page, context, baseURL, [task({ prompt: '<img src=https://evil.example/x.png> prompt' })]);
    await page.waitForTimeout(500);
    await api.expectNoForeignRequests();
    await expect(page.locator('[data-task-id="task-1"] img')).toHaveCount(0);
  });
});

test.describe('/account/tasks', () => {
  test('lists tasks, filters by kind/status through the query and pages with the cursor', async ({ page, context, baseURL }) => {
    const api = await installApi(page, context, baseURL, {
      'GET /api/ai/tasks': (request) => {
        const before = request.url.searchParams.get('before');
        return { result: before ? { items: [task({ id: 'task-old', prompt: 'older one', status: 'COMPLETED', canCancel: false })], next: null } : { items: [task({ id: 'task-new', prompt: 'newer one', status: 'FAILED', canCancel: false, error: { code: 'AI_PROVIDER_FAILED', summary: 'secret provider text' } })], next: 'cur1' } };
      },
    });
    await page.goto('/account/tasks');
    await waitForHydratedAccount(page);
    await expect(page.getByRole('heading', { name: 'AI tasks' })).toBeVisible();
    await expect(page.getByText('newer one')).toBeVisible();
    await expect(page.getByText('AI_PROVIDER_FAILED')).toBeVisible();
    await expect(page.getByText('secret provider text')).toHaveCount(0);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('older one')).toBeVisible();
    expect(api.callsTo('GET /api/ai/tasks').at(-1)!.url.searchParams.get('before')).toBe('cur1');
    await page.getByLabel('Kind').selectOption('video');
    await expect.poll(() => api.callsTo('GET /api/ai/tasks').at(-1)!.url.searchParams.get('kind')).toBe('video');
    await page.getByLabel('Status').selectOption('FAILED');
    await expect.poll(() => api.callsTo('GET /api/ai/tasks').at(-1)!.url.searchParams.get('status')).toBe('FAILED');
  });
});
