// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createResendWebhookController } from './resend-webhook.controller';
const ResendWebhookController = createResendWebhookController('webhooks/provider');

describe('Resend webhook acknowledgement', () => {
  const request = {
    rawBody: Buffer.from(JSON.stringify({ type: 'email.opened', data: { email_id: 'synthetic' } })),
  };
  it('rejects unauthenticated events before recording them', async () => {
    const handleEvent = vi.fn();
    const controller = new ResendWebhookController({
      verifySignature: () => false,
      handleEvent,
    } as never);
    await expect(controller.handle(request as never, {})).rejects.toMatchObject({ status: 401 });
    expect(handleEvent).not.toHaveBeenCalled();
  });
  it('returns a retryable error on database failure instead of losing the event', async () => {
    const controller = new ResendWebhookController({
      verifySignature: () => true,
      handleEvent: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);
    await expect(controller.handle(request as never, {})).rejects.toMatchObject({ status: 503 });
  });
  it('acknowledges only after persistence succeeds', async () => {
    const handleEvent = vi.fn().mockResolvedValue(undefined);
    const controller = new ResendWebhookController({
      verifySignature: () => true,
      handleEvent,
    } as never);
    await expect(controller.handle(request as never, {})).resolves.toEqual({ received: true });
    expect(handleEvent).toHaveBeenCalledWith({
      type: 'email.opened',
      data: { email_id: 'synthetic' },
    });
  });
});
