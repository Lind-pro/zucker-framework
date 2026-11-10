import { createRequire } from 'node:module';
import type { OrdersController } from '@paypal/paypal-server-sdk';
import type { PaymentSettlementState } from './payment-observation';

const requireSdk = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

export interface PayPalPaymentTransportOptions {
  clientId: string;
  clientSecret: string;
  mode: 'live' | 'sandbox';
  fetcher?: typeof fetch;
  logger?: { warn: (message: string) => void; error: (message: string) => void };
  /** Per-request timeout for SDK and REST calls (milliseconds). Defaults to 10 000. */
  timeoutMs?: number;
}

const PAYPAL_REQUEST_TIMEOUT_MS = 10000;

export interface PayPalCaptureRefundRequest {
  /**
   * 省略表示全额退款——PayPal 的 refund 接口本就允许不传 amount。
   * 原先声明为必填，导致调用方为了"全额退"必须自己算出金额再传回去，
   * 一旦本地金额与供应商记录有出入就会退错数额。
   */
  amount?: { value: string; currency_code: string };
  note_to_payer?: string;
  custom_id?: string;
}

export interface PayPalCaptureRefundResponse {
  id?: string;
  status?: string;
  message?: string;
}

export interface PayPalSaleRefundRequest {
  amount?: { total: string; currency: string };
  description?: string;
  invoice_number?: string;
}
export class PayPalPaymentProtocolError extends Error {
  constructor(readonly outcome: 'unknown' | 'rejected', readonly status?: number) {
    super(status === undefined ? 'PayPal payment request outcome is unavailable' : `PayPal payment request returned HTTP ${status}`);
    this.name = 'PayPalPaymentProtocolError';
  }
}

export interface PayPalSubscriptionCreateInput {
  plan_id: string;
  custom_id: string;
  quantity: '1';
  application_context: { return_url: string; cancel_url: string; brand_name?: string; user_action: 'SUBSCRIBE_NOW'; shipping_preference: 'NO_SHIPPING' };
}
export interface PayPalSubscriptionTransaction {
  id: string;
  status: string;
  time?: string;
  amount_with_breakdown?: { gross_amount?: { value?: string; currency_code?: string } };
}
export interface PayPalSubscriptionTransactionPage {
  transactions: PayPalSubscriptionTransaction[];
  nextCursor?: string;
}

export interface PayPalOrderRepresentation {
  id?: string;
  status?: string;
  links?: Array<{ rel?: string; href?: string }>;
  purchaseUnits?: Array<{ payments?: { captures?: Array<{ id?: string }> } }>;
}

export interface PayPalOrderObservation<
  T extends PayPalOrderRepresentation = PayPalOrderRepresentation,
> {
  raw: T;
  id?: string;
  approveUrl?: string;
  captureId?: string;
  settlement: PaymentSettlementState;
}

/** APPROVED means approval only, never evidence of a captured payment. */
export function observePayPalOrder<T extends PayPalOrderRepresentation>(
  raw: T,
): PayPalOrderObservation<T> {
  return {
    raw,
    id: raw.id,
    approveUrl: raw.links?.find((link) => link.rel === 'approve')?.href,
    captureId: raw.purchaseUnits?.[0]?.payments?.captures?.[0]?.id,
    settlement:
      raw.status === 'COMPLETED' ? 'paid' : raw.status === 'VOIDED' ? 'unpaid' : 'unknown',
  };
}

export interface PayPalCaptureObservation {
  raw: Record<string, unknown>;
  id: string;
  failureReason?: string;
}

export type PayPalWebhookObservation =
  | {
      raw: Record<string, unknown>;
      type: string;
      kind: 'capture-succeeded' | 'capture-failed';
      capture: PayPalCaptureObservation;
    }
  | { raw: Record<string, unknown>; type: string; kind: 'unknown' };

export interface PayPalMoneyReturnedObservation {
  id: string;
  captureId?: string;
  orderId?: string;
  amount: string;
  currency: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
}

/** Extract identifiers only; never fetch a provider-supplied HATEOAS URL. */
function captureLinkId(resource: Record<string, unknown>): string | undefined {
  if (!Array.isArray(resource.links)) return undefined;
  for (const value of resource.links) {
    const link = asRecord(value);
    if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href);
      if (url.protocol !== 'https:' || !/^api(?:-m)?(?:\.sandbox)?\.paypal\.com$/.test(url.hostname)) continue;
      const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (match) return match[1];
    } catch { /* Invalid links cannot establish payment identity. */ }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode only after signature verification; this performs no authentication or network call. */
export function decodePayPalWebhookEvent(payload: string): PayPalWebhookObservation {
  const raw = asRecord(JSON.parse(payload));
  if (!raw || typeof raw.event_type !== 'string') throw new Error('Invalid PayPal webhook event');
  const type = raw.event_type;
  const kind =
    type === 'PAYMENT.CAPTURE.COMPLETED'
      ? 'capture-succeeded'
      : type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED'
        ? 'capture-failed'
        : 'unknown';
  if (kind === 'unknown') return { raw, type, kind };
  const resource = asRecord(raw.resource);
  if (!resource || typeof resource.id !== 'string' || !resource.id) {
    throw new Error('PayPal capture event is missing its resource ID');
  }
  const reason = asRecord(resource.status_details)?.reason;
  return {
    raw,
    type,
    kind,
    capture: {
      raw: resource,
      id: resource.id,
      failureReason: typeof reason === 'string' ? reason : undefined,
    },
  };
}

/** Additive decoder: the original capture-event discriminated union stays compatible. */
export function decodePayPalMoneyReturnedEvent(payload: string): {
  raw: Record<string, unknown>; type: string;
  kind: 'capture-refunded' | 'capture-reversed'; returned: PayPalMoneyReturnedObservation;
} | null {
  const raw = asRecord(JSON.parse(payload));
  if (!raw || typeof raw.event_type !== 'string') throw new Error('Invalid PayPal webhook event');
  const type = raw.event_type;
  if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    const resource = asRecord(raw.resource);
    const amount = asRecord(resource?.amount);
    const related = asRecord(asRecord(resource?.supplementary_data)?.related_ids);
    const reversal = type === 'PAYMENT.CAPTURE.REVERSED';
    if (!resource || typeof resource.id !== 'string' || !resource.id ||
        typeof amount?.value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(amount.value) ||
        typeof amount.currency_code !== 'string' || !/^[A-Z]{3}$/.test(amount.currency_code)) {
      throw new Error('Invalid PayPal money-returned event');
    }
    const status = reversal ? 'COMPLETED' : resource.status;
    if (status !== 'PENDING' && status !== 'COMPLETED' && status !== 'FAILED' && status !== 'CANCELLED') {
      throw new Error('Unknown PayPal refund status');
    }
    const captureId = reversal ? resource.id :
      typeof related?.capture_id === 'string' ? related.capture_id : captureLinkId(resource);
    const orderId = typeof related?.order_id === 'string' ? related.order_id : undefined;
    if (!captureId && !orderId) throw new Error('PayPal refund event has no capture or order identity');
    return { raw, type, kind: reversal ? 'capture-reversed' : 'capture-refunded', returned: {
      id: reversal ? `reversal:${resource.id}` : resource.id,
      captureId, orderId, amount: amount.value, currency: amount.currency_code, status,
    } };
  }
  return null;
}

/** SDK order transport plus the OAuth-backed REST endpoints absent from the current SDK integration. */
export class PayPalPaymentTransport {
  readonly orders: OrdersController;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  get environment(): 'live' | 'sandbox' { return this.options.mode; }
  private get requestTimeoutMs(): number { return this.options.timeoutMs ?? PAYPAL_REQUEST_TIMEOUT_MS; }

  constructor(private readonly options: PayPalPaymentTransportOptions) {
    const { Client, Environment, LogLevel, OrdersController } = requireSdk(
      '@paypal/paypal-server-sdk',
    ) as typeof import('@paypal/paypal-server-sdk');
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: options.clientId,
        oAuthClientSecret: options.clientSecret,
      },
      // A finite timeout: an SDK call that never returns would hold a capture claim and request forever.
      timeout: options.timeoutMs ?? PAYPAL_REQUEST_TIMEOUT_MS,
      environment: options.mode === 'live' ? Environment.Production : Environment.Sandbox,
      logging: {
        logLevel: LogLevel.Info,
        logRequest: { logBody: false },
        logResponse: { logHeaders: false },
      },
    });
    this.orders = new OrdersController(client);
    this.baseUrl =
      options.mode === 'live' ? 'https://api.paypal.com' : 'https://api.sandbox.paypal.com';
    this.fetcher = options.fetcher ?? fetch;
  }

  async createOrder(input: Parameters<OrdersController['createOrder']>[0]) {
    const { result } = await this.orders.createOrder(input);
    return observePayPalOrder(result);
  }

  /** An explicit capture command; never invoked by getOrder or status observation. */
  async captureOrder(input: Parameters<OrdersController['captureOrder']>[0]) {
    const { result } = await this.orders.captureOrder(input);
    return observePayPalOrder(result);
  }

  async getOrder(input: Parameters<OrdersController['getOrder']>[0]) {
    const { result } = await this.orders.getOrder(input);
    return observePayPalOrder(result);
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error('Unable to obtain PayPal access token');
    const data = (await response.json()) as { access_token?: unknown };
    if ( typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('Unable to obtain PayPal access token');
    }
    return data.access_token;
  }

  /** Fixed-origin subscription endpoints; errors never include credentials, raw bodies or provider URLs. */
  private async subscriptionRequest(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
    try {
      const accessToken = await this.getAccessToken(AbortSignal.timeout(this.requestTimeoutMs));
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, signal: AbortSignal.timeout(this.requestTimeoutMs), redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
          ...(requestId ? { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error();
      if (response.status === 204) return {};
      const result = asRecord(await response.json());
      if (!result) throw new Error();
      return result;
    } catch { throw new Error('PayPal subscription request failed; outcome may be unknown'); }
  }

  async createSubscription(input: PayPalSubscriptionCreateInput, requestId: string): Promise<Record<string, unknown>> {
    if (!requestId || requestId.length > 108 || /[\r\n]/.test(requestId)) throw new Error('Invalid PayPal subscription request ID');
    return this.subscriptionRequest('POST', '/v1/billing/subscriptions', input, requestId);
  }

  async getSubscription(id: string): Promise<Record<string, unknown>> {
    const raw = await this.subscriptionRequest('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}?fields=plan`);
    if (raw.id !== id) throw new Error('PayPal returned a different subscription');
    return raw;
  }

  async getSubscriptionPlan(id: string): Promise<Record<string, unknown>> {
    const raw = await this.subscriptionRequest('GET', `/v1/billing/plans/${encodeURIComponent(id)}`);
    if (raw.id !== id) throw new Error('PayPal returned a different plan');
    return raw;
  }

  async cancelSubscription(id: string, reason: string): Promise<void> {
    if (!reason.trim() || reason.length > 128) throw new Error('PayPal cancellation reason must be 1–128 characters');
    await this.subscriptionRequest('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason });
  }

  async listSubscriptionTransactions(id: string, input: { startTime: string; endTime: string; cursor?: string }): Promise<PayPalSubscriptionTransactionPage> {
    const path = `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions`;
    const query = new URLSearchParams({ start_time: input.startTime, end_time: input.endTime });
    const validateNext = (value: string): string => {
      try {
        const parsed = new URL(value, this.baseUrl);
        const allowedOrigins = this.options.mode === 'sandbox'
          ? ['https://api.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com']
          : ['https://api.paypal.com', 'https://api-m.paypal.com'];
        if (!allowedOrigins.includes(parsed.origin) || parsed.pathname !== path || parsed.username || parsed.password || parsed.hash ||
            parsed.searchParams.get('start_time') !== input.startTime || parsed.searchParams.get('end_time') !== input.endTime ||
            [...parsed.searchParams.keys()].some((key) => !['start_time', 'end_time', 'page', 'page_size'].includes(key) || parsed.searchParams.getAll(key).length !== 1)) throw new Error();
        return parsed.searchParams.toString();
      } catch { throw new Error('Invalid PayPal subscription pagination link'); }
    };
    if (!Number.isFinite(Date.parse(input.startTime)) || !Number.isFinite(Date.parse(input.endTime)) || Date.parse(input.startTime) >= Date.parse(input.endTime)) {
      throw new Error('Invalid PayPal subscription transaction window');
    }
    const suffix = input.cursor ? validateNext(`${path}?${input.cursor}`) : query.toString();
    const raw = await this.subscriptionRequest('GET', `${path}?${suffix}`);
    if (!Array.isArray(raw.transactions)) throw new Error('Invalid PayPal subscription transaction collection');
    const transactions = raw.transactions.map((value) => {
      const transaction = asRecord(value);
      if (!transaction || typeof transaction.id !== 'string' || !transaction.id || typeof transaction.status !== 'string') {
        throw new Error('Invalid PayPal subscription transaction identity');
      }
      return transaction as unknown as PayPalSubscriptionTransaction;
    });
    const next = Array.isArray(raw.links) ? raw.links.map(asRecord).find((link) => link?.rel === 'next') : undefined;
    const nextCursor = typeof next?.href === 'string' ? validateNext(next.href) : undefined;
    if (nextCursor === suffix || next && !nextCursor) throw new Error('PayPal subscription pagination made no progress');
    const pageNumber = Number(new URLSearchParams(suffix).get('page') ?? '1');
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 ||
        raw.total_pages !== undefined && (!Number.isSafeInteger(raw.total_pages) || Number(raw.total_pages) < 0)) {
      throw new Error('Invalid PayPal subscription pagination');
    }
    if (nextCursor && Number(new URLSearchParams(nextCursor).get('page')) !== pageNumber + 1) throw new Error('PayPal subscription pagination made no progress');
    if (!nextCursor && typeof raw.total_items === 'number' && raw.total_items > transactions.length && Number(raw.total_pages) <= 1) {
      throw new Error('Incomplete PayPal subscription transaction collection');
    }
    if (!nextCursor && typeof raw.total_pages === 'number' && raw.total_pages > pageNumber) throw new Error('PayPal transaction collection has no next page');
    return { transactions, nextCursor };
  }

  async verifyWebhookSignature(
    payload: string,
    headers: Record<string, string>,
    webhookId: string,
  ): Promise<boolean> {
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const certUrl = headers['paypal-cert-url'];
    const authAlgo = headers['paypal-auth-algo'];
    const transmissionSig = headers['paypal-transmission-sig'];
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
      this.options.logger?.warn('PayPal webhook is missing required signature headers');
      return false;
    }
    try {
      const accessToken = await this.getAccessToken(AbortSignal.timeout(this.requestTimeoutMs));
      const response = await this.fetcher(
        `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            auth_algo: authAlgo,
            cert_url: certUrl,
            transmission_id: transmissionId,
            transmission_sig: transmissionSig,
            transmission_time: transmissionTime,
            webhook_id: webhookId,
            webhook_event: JSON.parse(payload),
          }),
        },
      );
      if (!response.ok) return false;
      const result = (await response.json()) as { verification_status?: unknown };
      return result.verification_status === 'SUCCESS';
    } catch (error) {
      this.options.logger?.error(
        `PayPal webhook verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async refundCapture(
    captureId: string,
    request: PayPalCaptureRefundRequest,
    requestId?: string,
  ): Promise<PayPalCaptureRefundResponse> {
    const accessToken = await this.getAccessToken(AbortSignal.timeout(this.requestTimeoutMs));
    const response = await this.fetcher(
      `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`,
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        },
        body: JSON.stringify(request),
      },
    );
    // Check the status before parsing: a non-JSON 5xx must surface as a refund failure, not a SyntaxError.
    if (!response.ok)
      // statusCode lets callers tell a definite 4xx rejection from an unknown outcome.
      throw Object.assign(new Error(`PayPal refund request failed (${response.status})`), { statusCode: response.status });
    return (await response.json()) as PayPalCaptureRefundResponse;
  }

  private async paymentRequest(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
    if (requestId !== undefined && (!requestId || requestId.length > 78 || /[\r\n\u0000]/.test(requestId))) throw new PayPalPaymentProtocolError('rejected');
    let accessToken: string;
    try { accessToken = await this.getAccessToken(AbortSignal.timeout(this.requestTimeoutMs)); }
    catch { throw new PayPalPaymentProtocolError('rejected'); }
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new PayPalPaymentProtocolError([400, 401, 403, 404, 422].includes(response.status) ? 'rejected' : 'unknown', response.status);
      const result = asRecord(await response.json()); if (!result) throw new PayPalPaymentProtocolError('unknown'); return result;
    } catch (error) { if (error instanceof PayPalPaymentProtocolError) throw error; throw new PayPalPaymentProtocolError('unknown'); }
  }
  async getCapturePayment(id: string): Promise<Record<string, unknown>> {
    const result = await this.paymentRequest('GET', `/v2/payments/captures/${encodeURIComponent(id)}`);
    if (result.id !== id) throw new Error('PayPal returned a different captured payment'); return result;
  }
  async getSalePayment(id: string): Promise<Record<string, unknown>> {
    const result = await this.paymentRequest('GET', `/v1/payments/sale/${encodeURIComponent(id)}`);
    if (result.id !== id) throw new Error('PayPal returned a different sale payment'); return result;
  }
  /** Subscriptions v1 transactions use the sale protocol; never send a sale ID to the capture endpoint. */
  async createSaleRefund(id: string, body: PayPalSaleRefundRequest, requestId: string): Promise<Record<string, unknown>> {
    return this.paymentRequest('POST', `/v1/payments/sale/${encodeURIComponent(id)}/refund`, body, requestId);
  }
  /** Representation-returning protocol for the typed refund adapter; legacy refundCapture stays compatible. */
  async createCaptureRefund(id: string, body: PayPalCaptureRefundRequest, requestId: string): Promise<Record<string, unknown>> {
    return this.paymentRequest('POST', `/v2/payments/captures/${encodeURIComponent(id)}/refund`, body, requestId);
  }
  async getCaptureRefund(id: string): Promise<Record<string, unknown>> {
    const result = await this.paymentRequest('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`);
    if (result.id !== id) throw new Error('PayPal returned a different capture refund'); return result;
  }
  async getSaleRefund(id: string): Promise<Record<string, unknown>> {
    const result = await this.paymentRequest('GET', `/v1/payments/refund/${encodeURIComponent(id)}`);
    if (result.id !== id) throw new Error('PayPal returned a different sale refund'); return result;
  }
}
