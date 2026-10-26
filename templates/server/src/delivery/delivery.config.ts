import { EmailProvider, ResendEmailProvider, type MailProvider } from '@zucker-framework/notification';

export const DELIVERY_OPTIONS = Symbol('DELIVERY_OPTIONS');
/** Resend keeps idempotency keys for 24 hours; leave one hour of margin. */
export const MAX_DELIVERY_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export interface DeliveryOptions { provider?: MailProvider; accountScope: string; leaseMs: number; heartbeatMs: number; replayWindowMs?: number }
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for durable email`);
  return value;
}
/** A separate explicit durable-delivery profile; never silently reuse account-email credentials. */
export function deliveryOptionsFromEnvironment(env: NodeJS.ProcessEnv): DeliveryOptions {
  const kind = env.DELIVERY_PROVIDER ?? 'none';
  const replayWindowMs = env.DELIVERY_REPLAY_WINDOW_MS === undefined ? MAX_DELIVERY_REPLAY_WINDOW_MS : Number(env.DELIVERY_REPLAY_WINDOW_MS);
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs < 1 || replayWindowMs > MAX_DELIVERY_REPLAY_WINDOW_MS)
    throw new Error('DELIVERY_REPLAY_WINDOW_MS must be positive and at most 23 hours');
  const base = { accountScope: '', leaseMs: 30_000, heartbeatMs: 5_000, replayWindowMs };
  if (kind === 'none') return base;
  const accountScope = required(env, 'DELIVERY_ACCOUNT_SCOPE'), from = required(env, 'DELIVERY_FROM');
  if (kind === 'resend') return { ...base, accountScope,
    provider: new ResendEmailProvider({ apiKey: required(env, 'DELIVERY_RESEND_API_KEY'), from }) };
  if (kind === 'smtp') {
    const port = Number(env.DELIVERY_SMTP_PORT ?? 587);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DELIVERY_SMTP_PORT');
    return { ...base, accountScope, provider: new EmailProvider({ from, host: required(env, 'DELIVERY_SMTP_HOST'), port,
      secure: env.DELIVERY_SMTP_SECURE === 'true', auth: { user: required(env, 'DELIVERY_SMTP_USER'), pass: required(env, 'DELIVERY_SMTP_PASSWORD') } }) };
  }
  throw new Error('DELIVERY_PROVIDER must be none, smtp or resend');
}
