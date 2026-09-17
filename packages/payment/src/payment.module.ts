import {
  Module,
  DynamicModule,
  Global,
  type Type,
  type InjectionToken,
  type Provider,
} from '@nestjs/common';
import { PaymentProviderRegistry } from './contract/registry';
import { OrderService, type Order } from './order.service';
import { ORDER_PERSISTENCE, type OrderPersistence } from './order-persistence';
import {
  PaymentRecoveryService,
  RECOVERY_ATTEMPT_STORE,
  type RecoveryAttemptStore,
} from './recovery.service';
import type { PaymentProviderAdapter } from './contract/payment-contract';

export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';
const PAYMENT_OPTIONS = Symbol('PAYMENT_OPTIONS');

export interface PaymentModuleOptions {
  providers?: PaymentProviderAdapter[];
  orderPersistence: OrderPersistence<Order>;
  /** Required when using payment recovery mail; no process-memory default. */
  recoveryAttempts?: RecoveryAttemptStore;
}
export interface PaymentModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory: (...args: unknown[]) => PaymentModuleOptions | Promise<PaymentModuleOptions>;
  inject?: InjectionToken[];
}

function configuredProviders(): Provider[] {
  return [
    {
      provide: ORDER_PERSISTENCE,
      inject: [PAYMENT_OPTIONS],
      useFactory: (options: PaymentModuleOptions) => {
        if (!options.orderPersistence) throw new Error('Order persistence must be configured');
        return options.orderPersistence;
      },
    },
    {
      provide: RECOVERY_ATTEMPT_STORE,
      inject: [PAYMENT_OPTIONS],
      useFactory: (options: PaymentModuleOptions) => options.recoveryAttempts ?? null,
    },
    {
      provide: PaymentProviderRegistry,
      inject: [PAYMENT_OPTIONS],
      useFactory: (options: PaymentModuleOptions) =>
        new PaymentProviderRegistry(options.providers ?? []),
    },
    OrderService,
    PaymentRecoveryService,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [PaymentProviderRegistry],
      useFactory: (registry: PaymentProviderRegistry) => registry.list(),
    },
  ];
}

@Global()
@Module({})
export class ZuckerPaymentModule {
  static forRoot(options: PaymentModuleOptions): DynamicModule {
    return {
      module: ZuckerPaymentModule,
      global: true,
      providers: [{ provide: PAYMENT_OPTIONS, useValue: options }, ...configuredProviders()],
      exports: [PaymentProviderRegistry, OrderService, PaymentRecoveryService],
    };
  }
  static forRootAsync(options: PaymentModuleAsyncOptions): DynamicModule {
    return {
      module: ZuckerPaymentModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: PAYMENT_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...configuredProviders(),
      ],
      exports: [PaymentProviderRegistry, OrderService, PaymentRecoveryService],
    };
  }
}
