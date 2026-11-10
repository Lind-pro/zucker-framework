import type {
  CheckoutPaymentIntent,
  Order as PayPalOrder,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
} from '@paypal/paypal-server-sdk';
import type { PayPalPaymentTransport } from '../../providers/paypal';

/*
 * The PayPal SDK is an optional peer that PayPalPaymentTransport loads on use;
 * the package entry must not import it at module scope (CI rejects a bundle whose
 * entry imports an optional runtime dependency). These enum members are plain
 * string constants, so the literal values are pinned here and typed against the
 * SDK's enums so a future SDK rename still fails type-checking.
 */
const CAPTURE_INTENT = 'CAPTURE' as CheckoutPaymentIntent;
const PAY_NOW = 'PAY_NOW' as OrderApplicationContextUserAction;
const NO_SHIPPING = 'NO_SHIPPING' as OrderApplicationContextShippingPreference;
import type {
  CreatePaymentInput,
  PaymentProviderAdapter,
  PaymentSession,
  RefundInput,
  WebhookObservation,
  WebhookRequest,
} from '../payment-contract';
import type { SettlementState } from '../settlement';
import { toMinorUnits } from '../money';
import { PaymentRejectedError } from '../rejection';

/**
 * PayPal Orders v2 适配器。
 *
 * 只做协议转换与状态映射，不含任何产品策略。传输层沿用已在生产验证过的
 * PayPalPaymentTransport，本适配器不重写它。
 */
export interface PayPalAdapterOptions {
  transport: PayPalPaymentTransport;
  /** Webhook 验签用；缺失时 parseWebhook 必须拒绝，而不是放行 */
  webhookId?: string;
  brandName?: string;
}

/**
 * PayPal REST 支持的 25 种结算币种。
 * 来源：https://developer.paypal.com/api/rest/reference/currency-codes/
 * 这是供应商事实；"本产品只卖哪几种"属于上层应用，不写在这里。
 */
export const PAYPAL_SUPPORTED_CURRENCIES = [
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MYR',
  'MXN',
  'TWD',
  'NZD',
  'NOK',
  'PHP',
  'PLN',
  'GBP',
  'RUB',
  'SGD',
  'SEK',
  'CHF',
  'THB',
  'USD',
] as const;

/**
 * PayPal 订单状态 → 中立状态。
 *
 * 关键约定：顶层 COMPLETED 还不足以判定已扣款，必须同时看到一条 COMPLETED 的
 * capture；否则停在 authorized 继续观察。识别不了的状态一律 unknown，绝不猜成 failed。
 */
export function observePayPalState(order: PayPalOrder): SettlementState {
  const captures = order.purchaseUnits?.[0]?.payments?.captures ?? [];
  switch (order.status) {
    case 'CREATED':
    case 'SAVED':
    case 'PAYER_ACTION_REQUIRED':
      return 'created';
    case 'APPROVED':
      return 'authorized';
    case 'VOIDED':
      return 'canceled';
    case 'COMPLETED': {
      if (captures.some((capture) => capture.status === 'COMPLETED')) return 'captured';
      if (captures.some((c) => c.status === 'DECLINED' || c.status === 'FAILED')) return 'failed';
      return 'authorized';
    }
    default:
      return 'unknown';
  }
}

export function createPayPalAdapter(options: PayPalAdapterOptions): PaymentProviderAdapter {
  const { transport } = options;

  const toSession = (order: PayPalOrder): PaymentSession => {
    const unit = order.purchaseUnits?.[0];
    const approve = order.links?.find((link) => link.rel === 'approve')?.href;
    return {
      providerRef: order.id ?? '',
      nextAction: approve ? { kind: 'redirect', url: approve } : { kind: 'none' },
      state: observePayPalState(order),
      money: {
        amount: unit?.amount?.value ?? '0',
        currency: unit?.amount?.currencyCode ?? '',
      },
      raw: order,
    };
  };

  const refundStateOf = async (orderId: string): Promise<SettlementState> => {
    const payment = await transport.getOrder({ id: orderId });
    if (payment.raw.id !== orderId) return 'unknown';
    const captures = payment.raw.purchaseUnits?.flatMap((unit) => unit.payments?.captures ?? []) ?? [];
    if (captures.length !== 1) return 'unknown';
    const status = captures[0]?.status;
    return status === 'REFUNDED' ? 'refunded' : status === 'PARTIALLY_REFUNDED' ? 'partially_refunded' : 'unknown';
  };

  /**
   * Order id of a refund resource, resolved through its `rel: up` capture link. Only the capture id
   * is taken from the (signed) payload; the request goes to the configured PayPal API. Any failure
   * yields undefined, which keeps the webhook state `unknown`.
   */
  const orderOfRefund = async (links: Array<{ rel?: unknown; href?: unknown }> | undefined): Promise<string | undefined> => {
    const up = Array.isArray(links) ? links.find((link) => link?.rel === 'up' && typeof link.href === 'string') : undefined;
    const captureId = typeof up?.href === 'string' ? /\/v2\/payments\/captures\/([A-Za-z0-9-]{1,64})\/?$/.exec(up.href)?.[1] : undefined;
    if (!captureId) return undefined;
    try {
      const capture = await transport.getCapturePayment(captureId);
      const related = (capture.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
      return typeof related?.order_id === 'string' && related.order_id ? related.order_id : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    id: 'paypal',
    supportedCurrencies: PAYPAL_SUPPORTED_CURRENCIES,

    async createPayment(input: CreatePaymentInput): Promise<PaymentSession> {
      const payment = await transport.createOrder({
        body: {
          intent: CAPTURE_INTENT,
          purchaseUnits: [
            {
              referenceId: input.reference,
              amount: {
                currencyCode: input.money.currency,
                // 原样透传十进制字符串，不经过 Number
                value: input.money.amount,
              },
              description: input.description,
            },
          ],
          applicationContext: {
            returnUrl: input.returnUrl,
            cancelUrl: input.cancelUrl,
            userAction: PAY_NOW,
            shippingPreference: NO_SHIPPING,
            brandName: options.brandName,
          },
        },
        // 幂等：同一个键重试，PayPal 返回同一笔订单
        paypalRequestId: input.idempotencyKey,
        prefer: 'return=representation',
      });
      return toSession(payment.raw);
    },

    async capture(providerRef, idempotencyKey) {
      const payment = await transport.captureOrder({
        id: providerRef,
        paypalRequestId: idempotencyKey,
        prefer: 'return=representation',
      });
      return toSession(payment.raw);
    },

    /** 只读。对账会反复调用它，绝不能在这里触发 captureOrder。 */
    async retrieve(providerRef) {
      const payment = await transport.getOrder({ id: providerRef });
      return toSession(payment.raw);
    },

    async refund(input: RefundInput) {
      // providerRef remains the Orders v2 ID throughout this legacy contract. Refunds use
      // a capture ID, resolved by a read; never send the order ID to /captures/:id/refund.
      const payment = await transport.getOrder({ id: input.providerRef });
      if (payment.raw.id !== input.providerRef)
        throw new PaymentRejectedError('PayPal order reference does not match');
      const captures =
        payment.raw.purchaseUnits?.flatMap((unit) => unit.payments?.captures ?? []) ?? [];
      const settled = captures.filter((capture) =>
        ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(capture.status ?? ''),
      );
      const capture = settled[0];
      if (
        captures.length !== 1 ||
        settled.length !== 1 ||
        !capture?.id ||
        !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(capture.status ?? '')
      ) {
        throw new PaymentRejectedError('PayPal order must identify one refundable capture');
      }
      const currency = capture.amount?.currencyCode,
        amount = capture.amount?.value;
      if (
        !currency ||
        !amount ||
        !PAYPAL_SUPPORTED_CURRENCIES.includes(
          currency as (typeof PAYPAL_SUPPORTED_CURRENCIES)[number],
        )
      ) {
        throw new PaymentRejectedError('PayPal capture amount is unavailable');
      }
      const unitCurrency = ['JPY', 'HUF', 'TWD'].includes(currency) ? 'JPY' : 'USD';
      const capturedAmount = toMinorUnits(amount, unitCurrency);
      if (capturedAmount <= 0) throw new PaymentRejectedError('PayPal capture amount must be positive');
      if (input.money !== undefined) {
        if (!input.money || input.money.currency !== currency)
          throw new PaymentRejectedError('PayPal refund currency does not match the capture');
        const requested = toMinorUnits(input.money.amount, unitCurrency);
        if (requested <= 0 || requested > capturedAmount)
          throw new PaymentRejectedError('PayPal refund amount exceeds the capture or is not positive');
      }
      const refund = await transport.refundCapture(
        capture.id,
        {
          ...(input.money
            ? {
                amount: {
                  value: input.money.amount,
                  currency_code: input.money.currency,
                },
              }
            : {}),
          note_to_payer: input.reason,
        },
        input.idempotencyKey,
      );
      return {
        refundRef: refund.id ?? '',
        state:
          refund.status === 'COMPLETED'
            ? ('refunded' as SettlementState)
            : ('unknown' as SettlementState),
      };
    },

    async parseWebhook(request: WebhookRequest): Promise<WebhookObservation> {
      if (!options.webhookId) {
        throw new Error('PayPal webhookId is not configured; refusing to trust the request');
      }
      const body =
        typeof request.rawBody === 'string'
          ? request.rawBody
          : new TextDecoder().decode(request.rawBody);
      const valid = await transport.verifyWebhookSignature(
        body,
        request.headers,
        options.webhookId,
      );
      if (!valid) throw new Error('PayPal webhook signature verification failed');

      const event = JSON.parse(body) as {
        event_type?: string;
        resource?: {
          supplementary_data?: { related_ids?: { order_id?: string } };
          links?: Array<{ rel?: unknown; href?: unknown }>;
        };
      };
      const type = event.event_type ?? 'unknown';
      let providerRef = event.resource?.supplementary_data?.related_ids?.order_id;
      if (type === 'PAYMENT.CAPTURE.REFUNDED' && !providerRef) {
        // Refund resources usually omit the order id: follow the refund's `up` link to its capture.
        providerRef = await orderOfRefund(event.resource?.links);
      }
      let state: SettlementState =
        type === 'PAYMENT.CAPTURE.COMPLETED'
          ? 'captured'
          : type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED'
            ? 'failed'
            : type === 'PAYMENT.CAPTURE.REVERSED'
              ? 'refunded'
              : 'unknown';
      if (type === 'PAYMENT.CAPTURE.REFUNDED') {
        // The resource is one refund, possibly partial. Only the capture's own status tells
        // whether the payment is fully refunded, so re-read the order instead of guessing.
        state = providerRef ? await refundStateOf(providerRef) : 'unknown';
      }
      return { type, providerRef, state, raw: event };
    },
  };
}
