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
}

export interface PayPalCaptureRefundRequest {
  /**
   * 省略表示全额退款——PayPal 的 refund 接口本就允许不传 amount。
   * 原先声明为必填，导致调用方为了"全额退"必须自己算出金额再传回去，
   * 一旦本地金额与供应商记录有出入就会退错数额。
   */
  amount?: { value: string; currency_code: string };
  note_to_payer?: string;
}

export interface PayPalCaptureRefundResponse {
  id?: string;
  status?: string;
  message?: string;
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

  constructor(private readonly options: PayPalPaymentTransportOptions) {
    const { Client, Environment, LogLevel, OrdersController } = requireSdk(
      '@paypal/paypal-server-sdk',
    ) as typeof import('@paypal/paypal-server-sdk');
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: options.clientId,
        oAuthClientSecret: options.clientSecret,
      },
      timeout: 0,
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

  private async getAccessToken(): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    const data = (await response.json()) as { access_token?: unknown };
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('Unable to obtain PayPal access token');
    }
    return data.access_token;
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
      const accessToken = await this.getAccessToken();
      const response = await this.fetcher(
        `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
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
      const result = (await response.json()) as { verification_status?: unknown };
      return response.ok && result.verification_status === 'SUCCESS';
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
    const accessToken = await this.getAccessToken();
    const response = await this.fetcher(
      `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`,
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        },
        body: JSON.stringify(request),
      },
    );
    const result = (await response.json()) as PayPalCaptureRefundResponse;
    if (!response.ok)
      throw new Error(`PayPal refund request failed (${response.status})`);
    return result;
  }
}
