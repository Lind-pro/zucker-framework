import type { MailProvider, SendMailOptions } from './mail/mail-provider';
import { WebhookProvider, WebhookDeliveryError, type WebhookFetch } from './providers/webhook';

export interface NotificationCanaryChannelResult {
  channel: 'EMAIL' | 'WEBHOOK';
  outcome: 'success';
  idempotencyVerified: boolean;
  status?: number;
}
export type NotificationCanaryErrorCode =
  | 'provider_unavailable'
  | 'email_delivery_failed'
  | 'idempotency_unproven'
  | 'webhook_timeout'
  | 'webhook_transport'
  | 'webhook_http';

export class NotificationCanaryError extends Error {
  constructor(
    readonly code: NotificationCanaryErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NotificationCanaryError';
  }
}
export interface MailProviderCanaryOptions {
  provider: MailProvider;
  message: SendMailOptions;
  idempotencyKey: string;
  verifyIdempotency?: boolean;
  signal?: AbortSignal;
}

/** Deliver one probe (or two with the same key), then close the owned provider. */
export async function runMailProviderCanary(
  options: MailProviderCanaryOptions,
): Promise<NotificationCanaryChannelResult> {
  const { provider, message, idempotencyKey, signal, verifyIdempotency = false } = options;
  try {
    if (!provider.isConfigured() || !provider.supportsIdempotency) {
      throw new NotificationCanaryError(
        'provider_unavailable',
        'The canary requires a configured idempotent email provider.',
      );
    }
    const first = await provider.deliver(message, { idempotencyKey, signal });
    if (!first.success)
      throw new NotificationCanaryError(
        'email_delivery_failed',
        'Email notification canary failed.',
      );
    if (verifyIdempotency) {
      const second = await provider.deliver(message, { idempotencyKey, signal });
      if (!second.success || !first.messageId || second.messageId !== first.messageId) {
        throw new NotificationCanaryError(
          'idempotency_unproven',
          'Email provider did not prove stable idempotent delivery for the canary key.',
        );
      }
    }
    return { channel: 'EMAIL', outcome: 'success', idempotencyVerified: verifyIdempotency };
  } finally {
    await provider.close();
  }
}

export interface WebhookProviderCanaryOptions {
  /** The caller must authorize this destination before invoking the probe. */
  url: string | URL;
  payload: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetch?: WebhookFetch;
}

/** Send one no-redirect probe; HTTP success is not a proof of webhook idempotency. */
export async function runWebhookProviderCanary(
  options: WebhookProviderCanaryOptions,
): Promise<NotificationCanaryChannelResult> {
  const provider = new WebhookProvider({
    defaultUrl: String(options.url),
    headers: options.headers,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
    redirect: 'error',
  });
  try {
    const response = await provider.sendPayloadWithResponse(options.payload);
    return {
      channel: 'WEBHOOK',
      outcome: 'success',
      idempotencyVerified: false,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof WebhookDeliveryError) {
      if (error.reason === 'http')
        throw new NotificationCanaryError(
          'webhook_http',
          `Webhook notification canary was rejected with HTTP ${error.status}.`,
          error.status,
          { cause: error },
        );
      if (error.reason === 'timeout')
        throw new NotificationCanaryError(
          'webhook_timeout',
          'Webhook notification canary timed out.',
          undefined,
          { cause: error },
        );
    }
    throw new NotificationCanaryError(
      'webhook_transport',
      'Webhook notification canary transport failed.',
      undefined,
      { cause: error },
    );
  }
}
