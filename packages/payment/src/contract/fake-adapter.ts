import type {
  CreatePaymentInput,
  PaymentProviderAdapter,
  PaymentSession,
  RefundInput,
  WebhookRequest,
  WebhookObservation,
} from "./payment-contract";
import type { SettlementState } from "./settlement";

/**
 * 内存参考适配器。
 *
 * 两个用途：
 *   1. 让接入方在不连真实网关的情况下测自己的编排逻辑。
 *   2. 给 contract-suite 当基准——一个**正确**的适配器必须全过，
 *      故意写坏的变体必须被逐条抓出来。没有这一步，契约套件只是一组永远
 *      绿灯的断言，证明不了任何事。
 */
export interface FakeAdapterOptions {
  id?: string;
  supportedCurrencies?: readonly string[];
  /** 故意违约，用于验证 contract-suite 的检出能力 */
  defects?: {
    /** retrieve 里偷偷扣款——最贵的一类 bug */
    retrieveCaptures?: boolean;
    /** 忽略幂等键，每次都开新支付 */
    ignoreIdempotency?: boolean;
    /** 验签失败也不抛错，返回一个"未知"事件蒙混过去 */
    acceptsBadSignature?: boolean;
    /** 把中间态猜成 failed */
    guessesPendingAsFailed?: boolean;
    /** 金额按浮点处理 */
    mangleAmount?: boolean;
  };
}

interface FakePayment {
  ref: string;
  state: SettlementState;
  amount: string;
  currency: string;
}

export function createFakeAdapter(options: FakeAdapterOptions = {}) {
  const defects = options.defects ?? {};
  const payments = new Map<string, FakePayment>();
  const byIdempotencyKey = new Map<string, string>();
  const mutatingCalls: string[] = [];
  let counter = 0;

  const adapter: PaymentProviderAdapter = {
    id: options.id ?? "fake",
    supportedCurrencies: options.supportedCurrencies,

    async createPayment(input: CreatePaymentInput): Promise<PaymentSession> {
      mutatingCalls.push("createPayment");
      const existing = defects.ignoreIdempotency
        ? undefined
        : byIdempotencyKey.get(input.idempotencyKey);
      if (existing) {
        const payment = payments.get(existing)!;
        return session(payment);
      }
      const ref = `fake_${++counter}`;
      const amount = defects.mangleAmount
        ? String(Number(input.money.amount))
        : input.money.amount;
      const payment: FakePayment = {
        ref,
        state: "created",
        amount,
        currency: input.money.currency,
      };
      payments.set(ref, payment);
      byIdempotencyKey.set(input.idempotencyKey, ref);
      return session(payment);
    },

    async capture(providerRef: string): Promise<PaymentSession> {
      mutatingCalls.push("capture");
      const payment = expect(providerRef);
      payment.state = "captured";
      return session(payment);
    },

    async retrieve(providerRef: string): Promise<PaymentSession> {
      if (defects.retrieveCaptures) {
        mutatingCalls.push("capture");
        expect(providerRef).state = "captured";
      }
      const payment = expect(providerRef);
      if (defects.guessesPendingAsFailed && payment.state === "created") {
        return { ...session(payment), state: "failed" };
      }
      return session(payment);
    },

    async refund(input: RefundInput) {
      mutatingCalls.push("refund");
      const payment = expect(input.providerRef);
      payment.state = input.money ? "partially_refunded" : "refunded";
      return { refundRef: `refund_${payment.ref}`, state: payment.state };
    },

    async parseWebhook(request: WebhookRequest): Promise<WebhookObservation> {
      const valid = request.headers["x-fake-signature"] === "valid";
      if (!valid && !defects.acceptsBadSignature) {
        throw new Error("webhook signature verification failed");
      }
      const ref = request.headers["x-fake-ref"];
      return {
        type: "fake.payment.updated",
        providerRef: ref,
        state: ref && payments.has(ref) ? payments.get(ref)!.state : "unknown",
        raw: {},
      };
    },
  };

  function expect(ref: string): FakePayment {
    const payment = payments.get(ref);
    if (!payment) throw new Error(`unknown payment ${ref}`);
    return payment;
  }

  function session(payment: FakePayment): PaymentSession {
    return {
      providerRef: payment.ref,
      nextAction: { kind: "redirect", url: `https://fake.test/pay/${payment.ref}` },
      state: payment.state,
      money: { amount: payment.amount, currency: payment.currency },
      raw: {},
    };
  }

  return { adapter, mutatingCalls: () => [...mutatingCalls] };
}
