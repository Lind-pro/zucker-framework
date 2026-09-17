import type { Order as PayPalOrder } from "@paypal/paypal-server-sdk";
import {
  CheckoutPaymentIntent,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
} from "@paypal/paypal-server-sdk";
import type { PayPalPaymentTransport } from "../../providers/paypal";
import type {
  CreatePaymentInput,
  PaymentProviderAdapter,
  PaymentSession,
  RefundInput,
  WebhookObservation,
  WebhookRequest,
} from "../payment-contract";
import type { SettlementState } from "../settlement";

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
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF",
  "ILS", "JPY", "MYR", "MXN", "TWD", "NZD", "NOK", "PHP", "PLN",
  "GBP", "RUB", "SGD", "SEK", "CHF", "THB", "USD",
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
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      return "created";
    case "APPROVED":
      return "authorized";
    case "VOIDED":
      return "canceled";
    case "COMPLETED": {
      if (captures.some((capture) => capture.status === "COMPLETED")) return "captured";
      if (captures.some((c) => c.status === "DECLINED" || c.status === "FAILED")) return "failed";
      return "authorized";
    }
    default:
      return "unknown";
  }
}

export function createPayPalAdapter(
  options: PayPalAdapterOptions,
): PaymentProviderAdapter {
  const { transport } = options;

  const toSession = (order: PayPalOrder): PaymentSession => {
    const unit = order.purchaseUnits?.[0];
    const approve = order.links?.find((link) => link.rel === "approve")?.href;
    return {
      providerRef: order.id ?? "",
      nextAction: approve ? { kind: "redirect", url: approve } : { kind: "none" },
      state: observePayPalState(order),
      money: {
        amount: unit?.amount?.value ?? "0",
        currency: unit?.amount?.currencyCode ?? "",
      },
      raw: order,
    };
  };

  return {
    id: "paypal",
    supportedCurrencies: PAYPAL_SUPPORTED_CURRENCIES,

    async createPayment(input: CreatePaymentInput): Promise<PaymentSession> {
      const payment = await transport.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Capture,
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
            userAction: OrderApplicationContextUserAction.PayNow,
            shippingPreference:
              OrderApplicationContextShippingPreference.NoShipping,
            brandName: options.brandName,
          },
        },
        // 幂等：同一个键重试，PayPal 返回同一笔订单
        paypalRequestId: input.idempotencyKey,
        prefer: "return=representation",
      });
      return toSession(payment.raw);
    },

    async capture(providerRef, idempotencyKey) {
      const payment = await transport.captureOrder({
        id: providerRef,
        paypalRequestId: idempotencyKey,
        prefer: "return=representation",
      });
      return toSession(payment.raw);
    },

    /** 只读。对账会反复调用它，绝不能在这里触发 captureOrder。 */
    async retrieve(providerRef) {
      const payment = await transport.getOrder({ id: providerRef });
      return toSession(payment.raw);
    },

    async refund(input: RefundInput) {
      const refund = await transport.refundCapture(
        input.providerRef,
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
        refundRef: refund.id ?? "",
        state:
          refund.status === "COMPLETED"
            ? ("refunded" as SettlementState)
            : ("unknown" as SettlementState),
      };
    },

    async parseWebhook(request: WebhookRequest): Promise<WebhookObservation> {
      if (!options.webhookId) {
        throw new Error("PayPal webhookId is not configured; refusing to trust the request");
      }
      const body =
        typeof request.rawBody === "string"
          ? request.rawBody
          : new TextDecoder().decode(request.rawBody);
      const valid = await transport.verifyWebhookSignature(
        body,
        request.headers,
        options.webhookId,
      );
      if (!valid) throw new Error("PayPal webhook signature verification failed");

      const event = JSON.parse(body) as {
        event_type?: string;
        resource?: { supplementary_data?: { related_ids?: { order_id?: string } } };
      };
      const type = event.event_type ?? "unknown";
      const providerRef = event.resource?.supplementary_data?.related_ids?.order_id;
      const state: SettlementState =
        type === "PAYMENT.CAPTURE.COMPLETED"
          ? "captured"
          : type === "PAYMENT.CAPTURE.DENIED" || type === "PAYMENT.CAPTURE.DECLINED"
            ? "failed"
            : type === "PAYMENT.CAPTURE.REFUNDED"
              ? "refunded"
              : type === "PAYMENT.CAPTURE.REVERSED"
                ? "refunded"
                : "unknown";
      return { type, providerRef, state, raw: event };
    },
  };
}
