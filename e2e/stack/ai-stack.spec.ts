/**
 * Real-stack AI flows (no browser mocks): image generation submit → complete → download, chat that
 * streams incrementally through Web's /api rewrite, stop that settles once, and the header balance.
 * Requires the stack described in playwright.ai-stack.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';

const password = 'Synthetic-Pass-123!';

async function signUp(page: Page): Promise<string> {
  const username = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const response = await page.request.post('/api/authorize/register', {
    headers: { Origin: new URL(page.url() === 'about:blank' ? test.info().project.use.baseURL! : page.url()).origin },
    data: { username, email: `${username}@example.invalid`, password },
  });
  expect(response.status(), await response.text()).toBe(201);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTestId('header-credit-balance')).toBeVisible();
  return username;
}

async function headerBalance(page: Page): Promise<number> {
  const balance = page.getByTestId('header-credit-balance');
  await expect(balance).toHaveText(/\d/);
  return Number((await balance.innerText()).replace(/[^\d]/g, ''));
}

test('image: submit, complete, download; header balance drops by the price', async ({ page }) => {
  await signUp(page);
  await page.goto('/ai/image');
  const before = await headerBalance(page);
  await page.getByLabel('Prompt').fill('a synthetic test pattern');
  const submitted = page.waitForResponse((r) => r.url().endsWith('/api/ai/tasks') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  expect((await submitted).status()).toBe(202);
  const card = page.locator('[data-task-id]').first();
  await expect(card.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => headerBalance(page), { timeout: 10_000 }).toBe(before - 3);
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path!);
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG from the fake provider
});

test('chat streams incrementally through the /api rewrite; stop aborts and settles once', async ({ page }) => {
  await signUp(page);
  await page.goto('/chat');
  await expect(page.getByLabel('Model')).toBeVisible();
  const before = await headerBalance(page);

  // Arrival times of SSE events as the page's own fetch reads them.
  await page.evaluate(() => {
    const w = window as unknown as { __sse: Array<{ t: number; e: string }> };
    w.__sse = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/chat\/[^/]+\/messages$/.test(url) || !response.body) return response;
      const [mine, theirs] = response.body.tee();
      void (async () => {
        const reader = mine.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (done) break;
          for (const match of decoder.decode(value, { stream: true }).matchAll(/^event: (\w+)/gm)) w.__sse.push({ t: performance.now(), e: match[1]! });
        }
      })();
      return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
  const events = () => page.evaluate(() => (window as unknown as { __sse: Array<{ t: number; e: string }> }).__sse);

  const composer = page.locator('#chat-message');
  await composer.fill('one two three four five six');
  await composer.press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('six', { timeout: 20_000 });
  await expect.poll(async () => (await events()).some((event) => event.e === 'done')).toBe(true);
  const first = await events();
  const deltas = first.filter((event) => event.e === 'delta');
  const done = first.find((event) => event.e === 'done')!;
  expect(deltas.length).toBeGreaterThanOrEqual(5);
  // Incremental: deltas arrive spread over time (fake model waits 200 ms per chunk), well before done.
  expect(done.t - deltas[0]!.t).toBeGreaterThan(600);
  const gaps = deltas.slice(1).map((event, index) => event.t - deltas[index]!.t);
  expect(gaps.filter((gap) => gap > 100).length).toBeGreaterThanOrEqual(3);
  await expect.poll(() => headerBalance(page), { timeout: 10_000 }).toBeLessThan(before);
  const afterFirst = await headerBalance(page);

  // Stop: a long answer is aborted mid-stream; the server settles the message once as ABORTED.
  await composer.fill(Array.from({ length: 60 }, (_, index) => `word${index}`).join(' '));
  await composer.press('Enter');
  await expect.poll(async () => (await events()).filter((event) => event.e === 'delta').length, { timeout: 10_000 }).toBeGreaterThan(deltas.length + 3);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped. You were charged only for what was delivered.')).toBeVisible();
  const chatId = new URL(page.url()).searchParams.get('c');
  expect(chatId).toBeTruthy();
  const token = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const match = /"token":"([^"]+)"/.exec(localStorage.getItem(key) ?? '');
      if (match) return match[1];
    }
    return null;
  });
  expect(token).toBeTruthy();
  const detail = async () => (await (await page.request.get(`/api/chat/${chatId}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as
    { messages: Array<{ role: string; status: string; cost: number; content: string }>; cost: number };
  await expect.poll(async () => (await detail()).messages.at(-1)?.status, { timeout: 15_000 }).toBe('ABORTED');
  const settled = await detail();
  const aborted = settled.messages.at(-1)!;
  expect(aborted.content.length).toBeGreaterThan(0);
  expect(aborted.content).not.toContain('word59');
  // Settled once: the chat total equals the sum of message costs, and it does not move afterwards.
  const sum = settled.messages.reduce((total, message) => total + (message.cost ?? 0), 0);
  expect(settled.cost).toBe(sum);
  await page.waitForTimeout(2_000);
  expect((await detail()).cost).toBe(settled.cost);
  await expect.poll(() => headerBalance(page), { timeout: 10_000 }).toBe(afterFirst - aborted.cost);
  const balance = await page.request.get('/api/credits/balance', { headers: { Authorization: `Bearer ${token}` } });
  const body = (await balance.json()) as { available: number; frozen: number };
  expect(body.frozen).toBe(0);
  expect(body.available).toBe(afterFirst - aborted.cost);
});
