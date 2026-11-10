/**
 * Definite provider rejections versus unknown outcomes.
 *
 * Callers that claimed a dispatch (order `confirming` / `refunding`, hosted checkout `submitting`)
 * may only release the claim when the provider *definitely* did not move money. Network failures,
 * timeouts, 5xx, 408/409/429 and anything unclassified remain unknown and must be reconciled
 * with a read-only provider query instead.
 */
export class PaymentRejectedError extends Error {
  readonly outcome = 'rejected' as const;
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PaymentRejectedError';
  }
}

const AMBIGUOUS_STATUS = new Set([408, 409, 425, 429]);

export function isDefinitePaymentRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { outcome?: unknown; statusCode?: unknown; status?: unknown; type?: unknown };
  if (record.outcome === 'rejected') return true;
  if (record.outcome === 'unknown') return false;
  // Stripe SDK errors expose statusCode; the PayPal server SDK's ApiError exposes statusCode too.
  const status = typeof record.statusCode === 'number' ? record.statusCode
    : typeof record.status === 'number' ? record.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && !AMBIGUOUS_STATUS.has(status);
}
