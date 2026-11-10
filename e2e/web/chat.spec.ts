import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalog, chatSummary, installApi, sse, waitForHydratedAccount } from './ai-fixtures';

const start = { chatId: 'chat-new', messageId: 'a1', userMessageId: 'u1', providerId: 'ai-fake', model: 'chat-a', held: 2 };

async function openChat(page: Page, context: BrowserContext, baseURL: string | undefined, extra: Parameters<typeof installApi>[3] = {}) {
  const api = await installApi(page, context, baseURL, {
    'GET /api/ai/catalog': () => ({ result: catalog() }),
    'GET /api/chat': () => ({ result: { items: [], next: null } }),
    'POST /api/chat': () => ({ status: 201, result: chatSummary({ id: 'chat-new', title: 'New', messageCount: 0 }) }),
    ...extra,
  });
  await page.goto('/chat');
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByLabel('Model')).toBeVisible();
  await waitForHydratedAccount(page);
  return api;
}
const composer = (page: Page) => page.locator('#chat-message');
const sendWithEnter = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
};
const transcript = (page: Page) => page.locator('[data-role]');

test.describe('/chat', () => {
  for (const [label, status, code, message] of [
    ['402 insufficient credits', 402, 'AI_TASK_INSUFFICIENT_CREDITS', 'You do not have enough credits to start an answer.'],
    ['409 chat busy', 409, 'AI_CHAT_BUSY', 'An answer is still being written in this conversation.'],
    ['400 invalid message', 400, 'AI_TOOL_UNAVAILABLE', 'This message was not accepted'],
  ] as const) {
    test(`pre-stream ${label} removes the optimistic messages and restores the text`, async ({ page, context, baseURL }) => {
      const api = await openChat(page, context, baseURL, {
        'POST /api/chat/chat-new/messages': () => ({ status, code, result: null }),
      });
      await sendWithEnter(page, 'please keep this text');
      await expect(page.getByText(message).first()).toBeVisible();
      await expect(transcript(page)).toHaveCount(0);
      await expect(composer(page)).toHaveValue('please keep this text');
      await expect(page.getByText('Start the conversation below.')).toBeVisible();
      expect(api.count('POST /api/chat/chat-new/messages')).toBe(1);
      // the user can retry with the restored text
      api.on('POST /api/chat/chat-new/messages', () => ({ raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: 'Done.' }], ['done', { messageId: 'a1', usage: { input: 1, output: 1 }, cost: 1 }]) } }));
      await composer(page).press('Enter');
      await expect(page.locator('[data-role="assistant"]')).toContainText('Done.');
      await expect(page.locator('[data-role="user"]')).toContainText('please keep this text');
      // a chat created for the refused turn is reused, not created twice
      expect(api.count('POST /api/chat')).toBe(1);
    });
  }

  test('a 5xx before streaming removes the pair and does not restore the text (the turn may be stored)', async ({ page, context, baseURL }) => {
    const api = await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': () => ({ status: 503, code: 'AI_PROVIDER_UNAVAILABLE', result: null }),
      'GET /api/chat/chat-new': () => ({ result: { ...chatSummary({ id: 'chat-new' }), messages: [] } }),
    });
    await sendWithEnter(page, 'maybe stored');
    await expect(page.getByText('The chat model is not available right now.')).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    await expect.poll(() => api.count('GET /api/chat/chat-new')).toBeGreaterThan(0);
  });

  test('a stream that closes without done marks the answer interrupted and keeps the partial text', async ({ page, context, baseURL }) => {
    await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': () => ({ raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: 'Half an ans' }]) } }),
    });
    await sendWithEnter(page, 'hello');
    const assistant = page.locator('[data-role="assistant"]');
    await expect(assistant).toHaveAttribute('data-status', 'FAILED');
    await expect(assistant).toContainText('Half an ans');
    await expect(page.getByRole('alert').filter({ hasNotText: /^$/ })).toContainText('The connection was lost before the answer finished');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible(); // not stuck in "Stop"
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('alert').filter({ hasNotText: /^$/ })).toHaveCount(0);
  });

  test('a network failure before any response is also interrupted, not stuck streaming', async ({ page, context, baseURL }) => {
    await openChat(page, context, baseURL, { 'POST /api/chat/chat-new/messages': () => ({ abort: true }) });
    await sendWithEnter(page, 'hello');
    await expect(page.locator('[data-role="assistant"]')).toHaveAttribute('data-status', 'FAILED');
    await expect(page.getByRole('alert').filter({ hasNotText: /^$/ })).toContainText('The connection was lost');
    await expect(composer(page)).toBeEnabled();
  });

  test('an SSE error event settles the answer with the code and charged cost', async ({ page, context, baseURL }) => {
    await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': () => ({ raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: 'Partial' }], ['error', { code: 'AI_PROVIDER_FAILED', message: 'raw provider text', messageId: 'a1', usage: { input: 1, output: 3 }, cost: 1 }]) } }),
    });
    await sendWithEnter(page, 'hello');
    await expect(page.getByRole('alert').filter({ hasNotText: /^$/ })).toContainText('The model stopped answering');
    await expect(page.getByText('raw provider text')).toHaveCount(0);
    await expect(page.locator('[data-role="assistant"]')).toContainText('Partial');
    await expect(page.locator('[data-role="assistant"]')).toContainText('1 credits');
  });

  test('Enter during IME composition does not send; Shift+Enter inserts a newline; plain Enter sends', async ({ page, context, baseURL }) => {
    const api = await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': () => ({ raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: 'ok' }], ['done', { messageId: 'a1', cost: 0 }]) } }),
    });
    await composer(page).fill('你好');
    await composer(page).evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(400);
    expect(api.count('POST /api/chat')).toBe(0);
    expect(api.count('POST /api/chat/chat-new/messages')).toBe(0);
    await expect(composer(page)).toHaveValue('你好');
    await composer(page).press('Shift+Enter');
    await composer(page).type('第二行');
    await expect(composer(page)).toHaveValue('你好\n第二行');
    expect(api.count('POST /api/chat/chat-new/messages')).toBe(0);
    await composer(page).press('Enter');
    await expect(page.locator('[data-role="assistant"]')).toContainText('ok');
    expect((api.callsTo('POST /api/chat/chat-new/messages')[0]!.body as { content: string }).content).toBe('你好\n第二行');
  });

  test('whitespace-only input never sends', async ({ page, context, baseURL }) => {
    const api = await openChat(page, context, baseURL);
    await composer(page).fill('   \n  ');
    await composer(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await page.waitForTimeout(300);
    expect(api.count('POST /api/chat')).toBe(0);
  });

  test('assistant markdown is sanitised: no HTML, no unsafe links, no images, no remote loads', async ({ page, context, baseURL }) => {
    const answer = [
      'Hello <b>raw</b> <script>window.__pwned = 1</script>',
      '[bad](javascript:window.__pwned=1) [data](data:text/html;base64,AAAA) [good](https://example.com/page)',
      '![pixel](https://evil.example/pixel.png)',
      '<img src="https://evil.example/tracker.png" onerror="window.__pwned=1">',
    ].join('\n\n');
    const api = await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': () => ({ raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: answer }], ['done', { messageId: 'a1', cost: 1 }]) } }),
    });
    await sendWithEnter(page, 'render this');
    const body = page.locator('[data-role="assistant"] .chat-markdown');
    await expect(body).toContainText('Hello');
    await expect(body.locator('script, img, iframe, b')).toHaveCount(0);
    await expect(body.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
    const good = body.getByRole('link', { name: 'good' });
    await expect(good).toHaveAttribute('href', 'https://example.com/page');
    await expect(good).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    await expect(good).toHaveAttribute('target', '_blank');
    // the remote image is only a link; nothing is fetched
    await expect(body.getByRole('link', { name: 'pixel' })).toHaveAttribute('href', 'https://evil.example/pixel.png');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await page.waitForTimeout(300);
    await api.expectNoForeignRequests();
  });

  test('stop aborts the stream and shows the stopped state', async ({ page, context, baseURL }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await openChat(page, context, baseURL, {
      'POST /api/chat/chat-new/messages': async () => { await gate; return { raw: { contentType: 'text/event-stream', body: sse(['start', start], ['delta', { text: 'late' }], ['done', { messageId: 'a1', cost: 1 }]) } }; },
    });
    await sendWithEnter(page, 'slow one');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('[data-role="assistant"]')).toHaveAttribute('data-status', 'ABORTED');
    await expect(page.getByText('Stopped. You were charged only for what was delivered.')).toBeVisible();
    release();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-role="assistant"]')).toHaveAttribute('data-status', 'ABORTED');
  });

  test('opens a saved conversation from ?c= and a bad id is ignored', async ({ page, context, baseURL }) => {
    const message = (id: string, role: string, content: string) => ({ id, role, content, reasoning: null, status: 'COMPLETE', providerId: 'ai-fake', model: 'chat-a', usage: null, cost: 0, errorCode: null, createdAt: '2026-11-10T00:00:00Z', completedAt: null });
    const api = await installApi(page, context, baseURL, {
      'GET /api/ai/catalog': () => ({ result: catalog() }),
      'GET /api/chat': () => ({ result: { items: [chatSummary({ id: 'chat-9' })], next: null } }),
      'GET /api/chat/chat-9': () => ({ result: { ...chatSummary({ id: 'chat-9' }), messages: [message('m1', 'user', 'question'), message('m2', 'assistant', 'the **answer**')] } }),
    });
    await page.goto('/chat?c=chat-9');
    await waitForHydratedAccount(page);
    await expect(page.locator('[data-role="assistant"] strong')).toHaveText('answer');
    await expect(page.locator('[data-role="user"]')).toContainText('question');
    await page.goto('/chat?c=../../etc/passwd');
    await expect(page.getByText('Start the conversation below.')).toBeVisible();
    expect(api.calls.some((call) => call.url.pathname.includes('passwd'))).toBe(false);
  });
});

test.describe('/account/chats', () => {
  async function openList(page: Page, context: BrowserContext, baseURL: string | undefined) {
    const items = [chatSummary({ id: 'chat-a', title: 'Alpha' }), chatSummary({ id: 'chat-b', title: 'Beta' })];
    const api = await installApi(page, context, baseURL, {
      'GET /api/chat': () => ({ result: { items, next: null } }),
    });
    await page.goto('/account/chats');
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
    await waitForHydratedAccount(page);
    return api;
  }
  const row = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });

  test('delete needs a confirmation; 409 busy keeps the chat and explains; a retry deletes it', async ({ page, context, baseURL }) => {
    const api = await openList(page, context, baseURL);
    api.on('DELETE /api/chat/chat-a', () => ({ status: 409, code: 'AI_CHAT_BUSY', result: null }));
    await row(page, 'Alpha').getByRole('button', { name: 'Delete', exact: true }).click();
    expect(api.count('DELETE /api/chat/chat-a')).toBe(0); // first click only asks
    await row(page, 'Alpha').getByRole('button', { name: 'Keep' }).click();
    await expect(row(page, 'Alpha').getByRole('button', { name: 'Delete permanently' })).toHaveCount(0);

    await row(page, 'Alpha').getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'Alpha').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText('An answer is still being written; try again when it finishes.')).toBeVisible();
    await expect(row(page, 'Alpha')).toBeVisible();
    expect(api.count('DELETE /api/chat/chat-a')).toBe(1);

    api.on('DELETE /api/chat/chat-a', () => ({ result: { deleted: true } }));
    await row(page, 'Alpha').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(row(page, 'Alpha')).toHaveCount(0);
    await expect(row(page, 'Beta')).toBeVisible();
    expect(api.count('DELETE /api/chat/chat-a')).toBe(2);
    expect(api.count('DELETE /api/chat/chat-b')).toBe(0);
  });

  test('a generic delete failure says so and keeps the row', async ({ page, context, baseURL }) => {
    const api = await openList(page, context, baseURL);
    api.on('DELETE /api/chat/chat-b', () => ({ status: 500, result: null }));
    await row(page, 'Beta').getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'Beta').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText('The conversation could not be deleted.')).toBeVisible();
    await expect(row(page, 'Beta')).toBeVisible();
  });

  test('rows link to the chat by id', async ({ page, context, baseURL }) => {
    await openList(page, context, baseURL);
    await expect(row(page, 'Alpha').getByRole('link', { name: 'Open' })).toHaveAttribute('href', /\/chat\?c=chat-a$/);
  });
});
