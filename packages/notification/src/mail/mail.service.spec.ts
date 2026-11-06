// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { MailService } from './mail.service';
import { MailProviderErrorCode } from './mail-provider';

function harness(interval = 0) {
  const create = vi.fn().mockResolvedValue({ id: 'history' });
  const db = {
    model: (name: string) =>
      name === 'emailLogs' ? { create } : { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as DatabaseAdapter;
  const provider = {
    name: 'test',
    supportsIdempotency: true,
    isConfigured: () => true,
    deliver: vi.fn().mockResolvedValue({ success: true, messageId: 'receipt' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mail = new MailService({
    database: db,
    providers: [provider],
    minimumIntervalMs: interval,
    maxRetries: 2,
    defaultReplyTo: 'reply@example.test',
    recipientLocale: async () => 'en',
    templates: {
      defaultLocale: 'fr',
      contentFields: { fr: 'bodyFr', en: 'bodyEn' },
      builtIns: [
        {
          key: 'notice',
          name: 'Notice',
          description: 'Notice',
          contents: { fr: '{{name}}', en: 'Hello {{name}}' },
        },
      ],
    },
    renderContent: (html, content) => html + (content?.footer ?? ''),
    logMetadata: (metadata) => {
      const safe = { ...metadata };
      delete safe.tracking;
      return safe;
    },
  });
  return { mail, provider, create };
}
afterEach(() => vi.useRealTimers());

describe('mail delivery orchestration', () => {
  it('uses locale policy, native receipts and awaits one final persisted delivery record', async () => {
    const { mail, provider, create } = harness();
    let finish!: (value: unknown) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let settled = false;
    const pending = mail
      .sendTemplateMailWithResult(
        'to@example.test',
        'notice',
        { name: '<A>' },
        'Subject',
        'user',
        { tracking: 'forged' },
        undefined,
        { idempotencyKey: 'delivery:one' },
        { footer: ' footer' },
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(provider.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ html: 'Hello &lt;A&gt; footer', replyTo: 'reply@example.test' }),
      expect.objectContaining({ idempotencyKey: 'delivery:one', signal: expect.any(AbortSignal) }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'success',
        messageId: 'receipt',
        metadata: { replyTo: 'reply@example.test', idempotencyKey: 'delivery:one' },
      }),
    });
    finish({ id: 'history' });
    expect(await pending).toMatchObject({ success: true, messageId: 'receipt' });
    await mail.onModuleDestroy();
  });
  it('rejects header injection and unsupported idempotency before dispatch', async () => {
    const { mail, provider } = harness();
    await expect(
      mail.sendMail({ to: 'one@example.test', subject: 'hello\r\nBcc: hidden' }),
    ).rejects.toThrow('header');
    provider.supportsIdempotency = false;
    expect(
      await mail.sendMailWithResult({
        to: 'one@example.test',
        subject: 'Hello',
        delivery: { idempotencyKey: 'delivery:one' },
      }),
    ).toMatchObject({ success: false, errorCode: MailProviderErrorCode.IDEMPOTENCY_UNSUPPORTED });
    expect(provider.deliver).not.toHaveBeenCalled();
    await mail.onModuleDestroy();
  });
  it('retries transient rate limits, stops on daily quotas and records only the final result', async () => {
    vi.useFakeTimers();
    const { mail, provider, create } = harness();
    provider.deliver
      .mockResolvedValueOnce({ success: false, error: '429 too many requests per second' })
      .mockResolvedValueOnce({ success: true, messageId: 'retried' });
    const pending = mail.sendMailWithResult({ to: 'one@example.test', subject: 'Retry' });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ success: true, messageId: 'retried' });
    expect(provider.deliver).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    provider.deliver
      .mockClear()
      .mockResolvedValue({ success: false, error: '429 daily quota exhausted' });
    await mail.sendMail({ to: 'one@example.test', subject: 'Stop' });
    expect(provider.deliver).toHaveBeenCalledOnce();
    await mail.onModuleDestroy();
  });
  it('cancels queued slots and drains shutdown without an extra provider call', async () => {
    vi.useFakeTimers();
    const { mail, provider } = harness(60000);
    await mail.sendMail({ to: 'one@example.test', subject: 'First' });
    const abort = new AbortController();
    const canceled = mail.sendMailWithResult({
      to: 'one@example.test',
      subject: 'Queued',
      delivery: { signal: abort.signal },
    });
    abort.abort();
    expect(await canceled).toMatchObject({
      success: false,
      errorCode: MailProviderErrorCode.ABORTED,
    });
    const stopped = mail.sendMailWithResult({ to: 'one@example.test', subject: 'Shutdown' });
    await mail.onModuleDestroy();
    expect(await stopped).toMatchObject({
      success: false,
      errorCode: MailProviderErrorCode.ABORTED,
    });
    expect(provider.deliver).toHaveBeenCalledOnce();
    expect(provider.close).toHaveBeenCalledOnce();
  });
  it('does not dispatch templates missing required context or malformed log metadata', async () => {
    const { mail, provider } = harness();
    expect(
      await mail.sendResolved('one@example.test', 'notice', { fr: '{{recordId}}' }, {}, 'Context'),
    ).toMatchObject({ success: false });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      mail.sendMailWithResult({
        to: 'one@example.test',
        subject: 'Metadata',
        logMetadata: circular,
      }),
    ).rejects.toThrow();
    expect(provider.deliver).not.toHaveBeenCalled();
    await mail.onModuleDestroy();
  });
});

describe('attributing visits from sent mail', () => {
  it('tags links to the configured site per message and leaves untagged messages unchanged', async () => {
    const provider = {
      name: 'test',
      supportsIdempotency: true,
      isConfigured: () => true,
      deliver: vi.fn().mockResolvedValue({ success: true, messageId: 'receipt' }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const db = {
      model: () => ({ create: vi.fn().mockResolvedValue({ id: 'history' }) }),
    } as unknown as DatabaseAdapter;
    const mail = new MailService({
      database: db,
      providers: [provider],
      minimumIntervalMs: 0,
      templates: { defaultLocale: 'en', contentFields: { en: 'bodyEn' }, builtIns: [] },
      linkTracking: {
        origins: ['https://site.test'],
        params: ({ template, campaignId }) =>
          template === 'code' ? null : { utm_source: 'email', utm_campaign: campaignId ?? template ?? 'mail' },
      },
    });
    const html = '<a href="https://site.test/write">Open</a>';
    await mail.sendMailWithResult({ to: 'a@example.test', subject: 'S', html, template: 'welcome' });
    await mail.sendMailWithResult({ to: 'a@example.test', subject: 'S', html, template: 'news', logMetadata: { campaignId: 'c1' } });
    await mail.sendMailWithResult({ to: 'a@example.test', subject: 'S', html, template: 'code' });
    const sent = provider.deliver.mock.calls.map((call) => call[0].html);
    expect(sent).toEqual([
      '<a href="https://site.test/write?utm_source=email&amp;utm_campaign=welcome">Open</a>',
      '<a href="https://site.test/write?utm_source=email&amp;utm_campaign=c1">Open</a>',
      html,
    ]);
    await mail.onModuleDestroy();
  });
});
