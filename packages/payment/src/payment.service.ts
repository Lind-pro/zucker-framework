import { Injectable, Logger } from '@nestjs/common';
import type {
  PaymentProvider,
  CreatePaymentParams,
  PaymentIntent,
  PaymentResult,
  PaymentStatus,
  RefundResult,
  WebhookEvent,
} from './payment.interface';

/**
 * 支付服务 — 管理多个 PaymentProvider 的注册和路由。
 *
 * 使用方式：
 *   paymentService.register(stripeProvider);
 *   paymentService.register(wechatPayProvider);
 *   await paymentService.createPaymentIntent('stripe', params);
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly providers = new Map<string, PaymentProvider>();

  /** 注册支付提供商 */
  register(provider: PaymentProvider): void {
    if (this.providers.has(provider.id)) {
      this.logger.warn(`PaymentProvider "${provider.id}" 已注册，将被覆盖`);
    }
    this.providers.set(provider.id, provider);
    this.logger.log(`PaymentProvider "${provider.id}" (${provider.name}) 已注册`);
  }

  /** 注销支付提供商 */
  unregister(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    if (removed) {
      this.logger.log(`PaymentProvider "${providerId}" 已注销`);
    }
    return removed;
  }

  /** 获取已注册的提供商列表 */
  listProviders(): PaymentProvider[] {
    return Array.from(this.providers.values());
  }

  /** 获取指定提供商 */
  getProvider(providerId: string): PaymentProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`PaymentProvider "${providerId}" 未注册。已注册: [${Array.from(this.providers.keys()).join(', ')}]`);
    }
    return provider;
  }

  /** 创建支付意图 */
  async createPaymentIntent(providerId: string, params: CreatePaymentParams): Promise<PaymentIntent> {
    const provider = this.getProvider(providerId);
    this.logger.log(`[${providerId}] 创建支付意图: ${params.amount} ${params.currency}`);
    return provider.createPaymentIntent(params);
  }

  /** 确认支付 */
  async confirmPayment(providerId: string, intentId: string): Promise<PaymentResult> {
    const provider = this.getProvider(providerId);
    this.logger.log(`[${providerId}] 确认支付: ${intentId}`);
    return provider.confirmPayment(intentId);
  }

  /** 退款 */
  async refund(providerId: string, paymentId: string, amount?: number, reason?: string): Promise<RefundResult> {
    const provider = this.getProvider(providerId);
    this.logger.log(`[${providerId}] 退款: ${paymentId}, amount=${amount ?? 'full'}`);
    return provider.refund(paymentId, amount, reason);
  }

  /** 查询支付状态 */
  async getPaymentStatus(providerId: string, intentId: string): Promise<PaymentStatus> {
    const provider = this.getProvider(providerId);
    return provider.getPaymentStatus(intentId);
  }

  /** 处理 Webhook */
  async handleWebhook(providerId: string, payload: unknown, signature: string): Promise<WebhookEvent> {
    const provider = this.getProvider(providerId);
    this.logger.log(`[${providerId}] 处理 Webhook`);
    return provider.handleWebhook(payload, signature);
  }
}
