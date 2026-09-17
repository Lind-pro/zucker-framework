import { Injectable, Logger } from "@nestjs/common";
import type { PaymentProviderAdapter } from "./payment-contract";
import { adapterSupportsCurrency } from "./payment-contract";

/**
 * 渠道适配器注册表。
 *
 * 取代旧的 PaymentService：那一版路由的是从未被任何适配器实现过的 PaymentProvider，
 * 并且把 createPaymentIntent / confirmPayment 之类的业务动作也挂在自己身上。
 * 这里只做注册与查找——编排（建单、履约、对账）属于上层应用，不属于注册表。
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly adapters = new Map<string, PaymentProviderAdapter>();

  constructor(adapters: readonly PaymentProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: PaymentProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道 "${adapter.id}" 已注册；重复注册通常意味着装配错误，不予静默覆盖`);
    }
    this.adapters.set(adapter.id, adapter);
    this.logger.log(`已注册支付渠道 "${adapter.id}"`);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): PaymentProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(
        `渠道 "${id}" 未注册。已注册：[${[...this.adapters.keys()].join(", ")}]`,
      );
    }
    return adapter;
  }

  list(): PaymentProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /** 能处理该币种的渠道；"本产品卖不卖这个币种"由上层决定，不在这里过滤。 */
  listForCurrency(currency: string): PaymentProviderAdapter[] {
    return this.list().filter((adapter) => adapterSupportsCurrency(adapter, currency));
  }
}
