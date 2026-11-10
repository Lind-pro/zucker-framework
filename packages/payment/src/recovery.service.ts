import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderService, OrderNotFoundError, type Order } from './order.service';
import { PaymentEvents, type PaymentRecoverySentEvent } from './payment.events';

/** 挽回邮件发送接口 — 由业务项目实现 */
export interface RecoveryMailSender {
  sendRecoveryEmail(params: RecoveryEmailParams): Promise<void>;
}

export interface RecoveryEmailParams {
  to: string;
  userName: string;
  orderId: string;
  orderNumber?: string;
  /** 十进制字符串，与 Order.amount / Money.amount 同一表示 */
  amount: string;
  currency: string;
  errorReason: string;
  retryUrl: string;
  expireHours: number;
  /** Stable key for this persisted send attempt. */
  idempotencyKey: string;
}

/** 用户信息查询接口 — 由业务项目实现 */
export interface RecoveryUserLookup {
  getUser(userId: string): Promise<{ email?: string; name?: string } | null>;
}

/** 重试链接生成接口 — 由业务项目实现或使用默认 */
export interface RecoveryUrlGenerator {
  generateRetryUrl(order: Order): Promise<string | null>;
}

export const RECOVERY_MAIL_SENDER = 'RECOVERY_MAIL_SENDER';
export const RECOVERY_USER_LOOKUP = 'RECOVERY_USER_LOOKUP';
export const RECOVERY_URL_GENERATOR = 'RECOVERY_URL_GENERATOR';
export const RECOVERY_ATTEMPT_STORE = 'RECOVERY_ATTEMPT_STORE';

/** Persisted attempt limits. claim must atomically reserve a unique number below maxAttempts. */
export interface RecoveryAttemptStore {
  claim(orderId: string, maxAttempts: number, at: Date): Promise<{ attemptNumber: number } | null>;
  get(orderId: string): Promise<{ count: number; lastAt: Date } | undefined>;
}

export interface RecoveryOptions {
  /** 最大挽回次数（默认 3） */
  maxAttempts?: number;
  /** 重试链接有效期（小时，默认 48） */
  retryLinkExpireHours?: number;
  /**
   * 前端基础 URL（用于默认重试链接生成）。未配置且未注入 RECOVERY_URL_GENERATOR 时不发送挽回邮件，
   * 绝不把客户引向 localhost。
   */
  frontendUrl?: string;
}

const DEFAULT_OPTIONS: Required<RecoveryOptions> = {
  maxAttempts: 3,
  retryLinkExpireHours: 48,
  frontendUrl: '',
};

/**
 * 付款失败挽回服务
 *
 * 流程：Webhook 失败 → handleFailedPayment() → 生成重试链接 → 发挽回邮件
 *
 * 依赖注入（均为可选，未注入时仅日志记录）：
 * - RECOVERY_MAIL_SENDER: 邮件发送实现
 * - RECOVERY_USER_LOOKUP: 用户信息查询
 * - RECOVERY_URL_GENERATOR: 自定义重试链接生成
 */
@Injectable()
export class PaymentRecoveryService {
  private readonly logger = new Logger(PaymentRecoveryService.name);
  private readonly options: Required<RecoveryOptions>;

  constructor(
    private readonly orderService: OrderService,
    @Inject(RECOVERY_ATTEMPT_STORE) private readonly attempts: RecoveryAttemptStore | null,
    @Optional()
    @Inject(RECOVERY_MAIL_SENDER)
    private readonly mailSender?: RecoveryMailSender,
    @Optional()
    @Inject(RECOVERY_USER_LOOKUP)
    private readonly userLookup?: RecoveryUserLookup,
    @Optional()
    @Inject(RECOVERY_URL_GENERATOR)
    private readonly urlGenerator?: RecoveryUrlGenerator,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {
    this.options = { ...DEFAULT_OPTIONS };
  }

  /** 设置挽回选项 */
  configure(options: RecoveryOptions): void {
    Object.assign(this.options, options);
  }

  /**
   * 处理付款失败 — 核心挽回入口
   */
  async handleFailedPayment(
    orderId: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    let order: Order;
    try {
      order = await this.orderService.getOrder(orderId);
    } catch (error) {
      if (!(error instanceof OrderNotFoundError)) throw error;
      this.logger.warn(`订单 ${orderId} 不存在，跳过挽回`);
      return;
    }

    if (order.status !== 'failed') {
      this.logger.warn(`订单 ${orderId} 状态为 ${order.status}，跳过挽回`);
      return;
    }

    if (!this.mailSender) {
      this.logger.warn('Recovery mail sender is not configured; no attempt was reserved');
      return;
    }
    if (!this.attempts) throw new Error('Recovery attempt persistence must be configured');

    // 查询用户信息
    const userId = order.metadata?.userId;
    let email: string | undefined;
    let userName = '';

    if (userId && this.userLookup) {
      const user = await this.userLookup.getUser(userId);
      email = user?.email;
      userName = user?.name ?? '';
    }

    if (!email) {
      email = order.metadata?.email;
    }

    if (!email) {
      this.logger.warn(`订单 ${orderId} 无法获取用户邮箱，跳过邮件发送`);
      return;
    }

    // 生成重试链接
    const retryUrl = await this.generateRetryUrl(order);
    if (!retryUrl) {
      this.logger.warn(`订单 ${orderId} 无法生成重试链接`);
      return;
    }

    // Reserve before sending. A crash/unknown mail outcome never frees the same attempt.
    const reservation = await this.attempts.claim(orderId, this.options.maxAttempts, new Date());
    if (!reservation) return;
    const attemptNumber = reservation.attemptNumber;
    await this.mailSender.sendRecoveryEmail({
      to: email,
      userName: userName || email.split('@')[0],
      orderId: order.id,
      orderNumber: order.metadata?.orderNumber,
      amount: order.amount,
      currency: order.currency,
      errorReason: friendlyErrorReason(errorCode, errorMessage),
      retryUrl,
      expireHours: this.options.retryLinkExpireHours,
      idempotencyKey: `payment-recovery:${orderId}:${attemptNumber}`,
    });

    // 发出挽回事件
    if (this.eventEmitter) {
      const event: PaymentRecoverySentEvent = {
        orderId,
        userId,
        email,
        retryUrl,
        attemptNumber,
      };
      this.eventEmitter.emit(PaymentEvents.PAYMENT_RECOVERY_SENT, event);
    }
  }

  /**
   * 重试失败订单 — 将 failed → created 并重新发起支付。
   * 幂等键由调用方给出且必须与上次不同，否则渠道会原样返回那笔已失败的支付。
   */
  retryOrder(orderId: string, idempotencyKey: string): Promise<Order> {
    return this.orderService.retryOrder(orderId, idempotencyKey);
  }

  getRecoveryAttempts(orderId: string): Promise<{ count: number; lastAt: Date } | undefined> {
    if (!this.attempts) throw new Error('Recovery attempt persistence must be configured');
    return this.attempts.get(orderId);
  }

  private async generateRetryUrl(order: Order): Promise<string | null> {
    if (this.urlGenerator) {
      return this.urlGenerator.generateRetryUrl(order);
    }
    if (!this.options.frontendUrl) return null;
    return `${this.options.frontendUrl.replace(/\/+$/, '')}/payment/retry/${encodeURIComponent(order.id)}`;
  }
}

/** Stripe 错误码 → 用户友好中文描述 */
export function friendlyErrorReason(errorCode?: string, errorMessage?: string): string {
  const codeMap: Record<string, string> = {
    card_declined: '银行卡被拒绝，请尝试其他支付方式',
    insufficient_funds: '余额不足，请确认账户余额后重试',
    expired_card: '银行卡已过期，请使用有效的银行卡',
    incorrect_cvc: '安全码(CVC)不正确，请重新输入',
    processing_error: '支付处理出错，请稍后重试',
    authentication_required: '需要额外验证，请完成银行的身份验证',
    do_not_honor: '银行拒绝了此交易，请联系发卡行或尝试其他支付方式',
  };

  if (errorCode && codeMap[errorCode]) return codeMap[errorCode];
  // Raw provider messages (errorMessage) are never put into customer mail: they can carry
  // internal identifiers or English provider jargon. Log them on the caller side instead.
  void errorMessage;
  return '支付过程中出现问题，请重试或更换支付方式';
}
