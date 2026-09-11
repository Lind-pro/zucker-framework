import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailProvider, EmailNotifierProvider } from '../providers/email';
import { ResendEmailProvider, ResendEmailNotifierProvider } from '../providers/resend-email';
import { MailProviderErrorCode } from './mail-provider';
import type { NotifyChannel } from '../notifier.interface';

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn(), verify: vi.fn() }));
vi.mock('nodemailer', () => ({ createTransport: vi.fn(() => smtp) }));
beforeEach(() => {
  vi.clearAllMocks();
  smtp.sendMail.mockResolvedValue({ messageId: 'smtp-receipt' });
  smtp.verify.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

const envelope = {
  from: 'Sender <sender@example.test>',
  to: ['one@example.test', 'two@example.test'],
  subject: 'Delivery report',
  html: '<p>Body</p>',
  text: 'Body',
  replyTo: 'support@example.test',
  cc: 'copy@example.test',
  bcc: ['audit@example.test'],
  attachments: [
    {
      filename: 'preview.png',
      content: Buffer.from('synthetic'),
      contentId: 'inline-preview',
      contentType: 'image/png',
    },
  ],
};
const smtpOptions = {
  host: 'smtp.example.test',
  port: 587,
  auth: { user: 'synthetic', pass: 'synthetic' },
  from: 'default@example.test',
};
const resendOptions = { apiKey: 're_synthetic_test', from: 'default@example.test' };
function stubResendFetch() {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'resend-receipt' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('portable email providers', () => {
  it('forwards SMTP envelopes, inline content IDs and message receipts', async () => {
    const provider = new EmailProvider(smtpOptions);
    expect(await provider.deliver(envelope)).toEqual({ success: true, messageId: 'smtp-receipt' });
    const { contentId, ...attachment } = envelope.attachments[0];
    expect(smtp.sendMail).toHaveBeenCalledWith({
      ...envelope,
      to: 'one@example.test, two@example.test',
      attachments: [{ ...attachment, cid: contentId }],
    });
    await provider.close();
    await provider.close();
    expect(smtp.close).toHaveBeenCalledOnce();
    expect(provider.isConfigured()).toBe(false);
  });
  it('rejects canceled or idempotency-required SMTP sends before dispatch', async () => {
    const provider = new EmailProvider(smtpOptions),
      abort = new AbortController();
    abort.abort();
    expect(await provider.deliver(envelope, { signal: abort.signal })).toMatchObject({
      success: false,
      errorCode: MailProviderErrorCode.ABORTED,
    });
    expect(await provider.deliver(envelope, { idempotencyKey: 'delivery:one' })).toMatchObject({
      success: false,
      errorCode: MailProviderErrorCode.IDEMPOTENCY_UNSUPPORTED,
    });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
  it('supports disabled SMTP configuration without opening a transport', async () => {
    const provider = new EmailProvider({ ...smtpOptions, enabled: false });
    expect(provider.isConfigured()).toBe(false);
    expect(await provider.deliver(envelope)).toMatchObject({ success: false });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
  it('uses the real Resend SDK to forward headers, cancellation, attachments and receipt IDs', async () => {
    const fetch = stubResendFetch(),
      signal = new AbortController().signal;
    const provider = new ResendEmailProvider(resendOptions);
    expect(await provider.deliver(envelope, { signal, idempotencyKey: 'delivery:one' })).toEqual({
      success: true,
      messageId: 'resend-receipt',
    });
    const request = fetch.mock.calls[0][1];
    expect(request.signal).toBe(signal);
    expect(new Headers(request.headers).get('Idempotency-Key')).toBe('delivery:one');
    expect(JSON.parse(request.body)).toMatchObject({
      from: envelope.from,
      to: envelope.to,
      reply_to: envelope.replyTo,
      cc: envelope.cc,
      bcc: envelope.bcc,
      attachments: [
        {
          filename: 'preview.png',
          content_id: 'inline-preview',
          content_type: 'image/png',
          content: Buffer.from('synthetic').toString('base64'),
        },
      ],
    });
  });
  it('does not dispatch canceled Resend requests and classifies in-flight cancellation', async () => {
    const fetch = stubResendFetch(),
      abort = new AbortController();
    abort.abort();
    const provider = new ResendEmailProvider(resendOptions);
    expect(await provider.deliver(envelope, { signal: abort.signal })).toMatchObject({
      errorCode: MailProviderErrorCode.ABORTED,
    });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    fetch.mockImplementationOnce(async () => {
      active.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    expect(await provider.deliver(envelope, { signal: active.signal })).toMatchObject({
      errorCode: MailProviderErrorCode.ABORTED,
    });
  });
  it('does not race asynchronous SDK initialization or dispatch after closing', async () => {
    const fetch = stubResendFetch();
    const provider = new ResendEmailProvider(resendOptions);
    const result = provider.deliver(envelope);
    await provider.close();
    expect(await result).toMatchObject({
      success: false,
      errorCode: MailProviderErrorCode.ABORTED,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the notifier API while returning provider receipts', async () => {
    stubResendFetch();
    const message = {
      channel: 'EMAIL' as NotifyChannel,
      to: 'one@example.test',
      subject: 'Report',
      content: '<p>Body</p>',
      variables: {},
    };
    const email = await new EmailNotifierProvider().createNotifier({
      id: 'smtp',
      configuration: smtpOptions,
    } as never);
    const resend = await new ResendEmailNotifierProvider().createNotifier({
      id: 'resend',
      configuration: resendOptions,
    } as never);
    expect(await email.send(message)).toMatchObject({ success: true, messageId: 'smtp-receipt' });
    expect(await resend.send(message)).toMatchObject({
      success: true,
      messageId: 'resend-receipt',
    });
    await email.close();
    await resend.close();
  });
});
