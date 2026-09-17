import type { SettlementState } from "./settlement";

/**
 * 多渠道支付的中立契约。
 *
 * 取代 ../payment.interface.ts 里那份未经任何适配器验证的 PaymentProvider。
 * 形状取自 CNIPA 已跑通 Stripe + PayPal 的 PaymentGateway，并按 Medusa
 * AbstractPaymentProcessor 的生命周期补齐授权/扣款分离，同时预留微信、
 * 支付宝这类非跳转渠道所需的结构。
 */

/**
 * 金额。
 *
 * 刻意用十进制字符串而不是 number：
 *   - 旧 PaymentProvider 用 `number` + 注释"最小单位（分）"，CNIPA 用 Decimal 元，
 *     两套单位并存迟早在某个边界上错一位。
 *   - 浮点数表示钱本身就是错的。
 *   - JPY/HUF/TWD 无小数位，cents 模型对它们是特例；字符串对所有币种一致。
 * 适配器负责在边界上转成各自 SDK 需要的形式。
 */
export interface Money {
  /** 十进制字符串，如 "29.00"；不接受 number */
  amount: string;
  /** ISO 4217，大写 */
  currency: string;
}

/**
 * 用户需要执行的下一步动作。
 *
 * 不能简化成 `redirectUrl?: string`——微信 Native 下单返回的是
 * `weixin://wxpay/bizpayurl?pr=...`，是要渲染成二维码给用户扫的字符串，
 * 不是能 location.assign 过去的地址；支付宝 PC 常返回需自动提交的表单。
 * 用判别联合表达，调用方按 kind 分派，新增渠道不必改已有分支。
 */
export type PaymentNextAction =
  | { kind: "redirect"; url: string }
  | { kind: "qrcode"; value: string }
  | { kind: "form_post"; action: string; fields: Record<string, string> }
  | { kind: "sdk_params"; params: Record<string, unknown> }
  | { kind: "none" };

export interface PaymentSession {
  /** 供应商侧的支付标识，后续 capture / retrieve / refund 都用它 */
  providerRef: string;
  nextAction: PaymentNextAction;
  state: SettlementState;
  /**
   * 供应商侧记录的金额。
   * 放在契约里而不是让调用方去 raw 里翻：金额是每个渠道都必须如实回传的字段，
   * 调用方要拿它和本地订单核对，不该为此了解某个供应商的响应结构。
   */
  money: Money;
  /** 供应商原始响应，供排查与对账留痕；不参与业务判断 */
  raw?: unknown;
}

export interface CreatePaymentInput {
  /** 调用方的订单标识，会回传到供应商以便双向核对 */
  reference: string;
  money: Money;
  description?: string;
  /** 付款完成/取消后的回跳地址；不适用的渠道可忽略 */
  returnUrl?: string;
  cancelUrl?: string;
  /**
   * 幂等键。同一个键重试必须返回同一笔支付，不得产生第二笔。
   * 旧接口完全没有这个概念，重试即重复下单。
   */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/**
 * Webhook 原始请求。
 *
 * 必须同时给出原始字节与**全部**请求头：PayPal 验签需要 5 个头
 * （paypal-transmission-id/time/sig、paypal-cert-url、paypal-auth-algo），
 * 旧接口的 `signature: string` 结构上装不下；微信 v3 同样需要多个头。
 * 验签必须针对原始字节，序列化过一轮再验会因键序/数字规范化失败。
 */
export interface WebhookRequest {
  rawBody: Uint8Array | string;
  headers: Record<string, string>;
}

export interface WebhookObservation {
  /** 供应商事件类型原文，便于排查 */
  type: string;
  /** 本次事件指向的支付；无法关联时为 undefined，调用方应告警而非静默丢弃 */
  providerRef?: string;
  /** 归一化后的状态；无法判定时为 unknown */
  state: SettlementState;
  raw: unknown;
}

export interface RefundInput {
  providerRef: string;
  /** 省略表示全额退款 */
  money?: Money;
  reason?: string;
  idempotencyKey: string;
}

/**
 * 渠道适配器。
 *
 * 实现约定：
 *   - 只做协议与状态映射，不做任何产品决策（金额、资格、时机、文案）。
 *   - retrieve 必须是只读的。对账会调用它，绝不能在对账过程中扣款——
 *     "查询顺手把 APPROVED 捕获了"是这类系统最贵的一类 bug。
 *   - 判定不了就返回 unknown，不要猜成 failed。
 */
export interface PaymentProviderAdapter {
  readonly id: string;
  /**
   * 该渠道客观支持的结算币种；undefined 表示未声明限制。
   * 这是供应商事实，不是产品策略——"我们只卖 USD"属于上层应用。
   */
  readonly supportedCurrencies?: readonly string[];

  createPayment(input: CreatePaymentInput): Promise<PaymentSession>;

  /** 授权与扣款分离的渠道用它完成扣款（PayPal APPROVED → capture） */
  capture(providerRef: string, idempotencyKey: string): Promise<PaymentSession>;

  /** 只读查询，供回跳后主动确认与定时对账使用 */
  retrieve(providerRef: string): Promise<PaymentSession>;

  refund(input: RefundInput): Promise<{ refundRef: string; state: SettlementState }>;

  cancel?(providerRef: string): Promise<PaymentSession>;

  /** 验签并归一化；验签失败必须抛错，不得返回一个"未知"事件蒙混过去 */
  parseWebhook(request: WebhookRequest): Promise<WebhookObservation>;
}

/** 该渠道能否处理这个币种；未声明限制时一律放行。 */
export function adapterSupportsCurrency(
  adapter: Pick<PaymentProviderAdapter, "supportedCurrencies">,
  currency: string,
): boolean {
  return (
    !adapter.supportedCurrencies ||
    adapter.supportedCurrencies.includes(currency.toUpperCase())
  );
}
