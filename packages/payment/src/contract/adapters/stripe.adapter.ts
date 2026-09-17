import type Stripe from "stripe";
import {
  createStripeCheckoutSession,
  retrieveStripeCheckoutSession,
  verifyStripeWebhookEvent,
} from "../../providers/stripe";
import type {
  CreatePaymentInput,
  PaymentProviderAdapter,
  PaymentSession,
  RefundInput,
  WebhookObservation,
  WebhookRequest,
} from "../payment-contract";
import type { SettlementState } from "../settlement";
import { fromMinorUnits, toMinorUnits } from "../money";

export interface StripeAdapterOptions {
  client: Stripe;
  /** Webhook 验签密钥；缺失时 parseWebhook 必须拒绝 */
  webhookSecret?: string;
  /** 传给 Checkout 的支付方式配置（pmc_xxx），由上层按业务决定 */
  paymentMethodConfiguration?: string;
}

/**
 * Stripe Checkout 会话状态 → 中立状态。
 * 识别不了的组合一律 unknown：Stripe 的异步支付方式（如银行转账）会长时间停在
 * complete + unpaid，那不是失败。
 */
export function observeStripeState(session: Stripe.Checkout.Session): SettlementState {
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    return "captured";
  }
  if (session.status === "expired") return "canceled";
  if (session.status === "open") return "created";
  return "unknown";
}

export function createStripeAdapter(
  options: StripeAdapterOptions,
): PaymentProviderAdapter {
  const { client } = options;

  const toSession = (raw: Stripe.Checkout.Session): PaymentSession => ({
    providerRef: raw.id,
    nextAction: raw.url ? { kind: "redirect", url: raw.url } : { kind: "none" },
    state: observeStripeState(raw),
    money: {
      amount: fromMinorUnits(raw.amount_total ?? 0, raw.currency ?? "usd"),
      currency: (raw.currency ?? "").toUpperCase(),
    },
    raw,
  });

  return {
    id: "stripe",
    // Stripe 支持的币种远超本契约会用到的范围，不声明限制；
    // 不受支持的币种由 Stripe 自己拒绝，胡乱穷举一份只会过期。
    supportedCurrencies: undefined,

    async createPayment(input: CreatePaymentInput): Promise<PaymentSession> {
      const observation = await createStripeCheckoutSession(
        client,
        {
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: input.money.currency.toLowerCase(),
                product_data: { name: input.description || input.reference },
                unit_amount: toMinorUnits(input.money.amount, input.money.currency),
              },
              quantity: 1,
            },
          ],
          success_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.reference,
          metadata: input.metadata,
          ...(options.paymentMethodConfiguration
            ? { payment_method_configuration: options.paymentMethodConfiguration }
            : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toSession(observation.raw);
    },

    /**
     * Stripe Checkout 默认自动扣款，没有独立的 capture 步骤。
     * 按契约仍需实现：返回当前真实状态即可，不得伪造成已扣款。
     */
    async capture(providerRef) {
      const observation = await retrieveStripeCheckoutSession(client, providerRef);
      return toSession(observation.raw);
    },

    async retrieve(providerRef) {
      const observation = await retrieveStripeCheckoutSession(client, providerRef);
      return toSession(observation.raw);
    },

    async refund(input: RefundInput) {
      const session = await retrieveStripeCheckoutSession(client, input.providerRef);
      const paymentIntent = session.paymentIntentId;
      if (!paymentIntent) throw new Error("该 Checkout 会话没有可退款的 PaymentIntent");
      const refund = await client.refunds.create(
        {
          payment_intent: paymentIntent,
          ...(input.money
            ? { amount: toMinorUnits(input.money.amount, input.money.currency) }
            : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        refundRef: refund.id,
        state: (refund.status === "succeeded" ? "refunded" : "unknown") as SettlementState,
      };
    },

    async parseWebhook(request: WebhookRequest): Promise<WebhookObservation> {
      if (!options.webhookSecret) {
        throw new Error("Stripe webhookSecret is not configured; refusing to trust the request");
      }
      const signature = request.headers["stripe-signature"];
      if (!signature) throw new Error("Stripe webhook is missing the stripe-signature header");
      // constructEvent 验签失败会抛错，契约要求的正是抛错而不是返回未知事件
      const event = verifyStripeWebhookEvent(
        client,
        typeof request.rawBody === "string"
          ? request.rawBody
          : Buffer.from(request.rawBody),
        signature,
        options.webhookSecret,
      );
      const object = event.data.object as { id?: string };
      const state: SettlementState =
        event.type === "checkout.session.completed"
          ? observeStripeState(event.data.object as Stripe.Checkout.Session)
          : event.type === "checkout.session.expired"
            ? "canceled"
            : event.type === "charge.refunded"
              ? "refunded"
              : "unknown";
      return { type: event.type, providerRef: object.id, state, raw: event };
    },
  };
}
