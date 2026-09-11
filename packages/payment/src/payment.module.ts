import {
  Module,
  DynamicModule,
  Global,
  type Type,
  type InjectionToken,
  type Provider,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { OrderService, type Order } from './order.service';
import { ORDER_PERSISTENCE, type OrderPersistence } from './order-persistence';
import {
  PaymentRecoveryService,
  RECOVERY_ATTEMPT_STORE,
  type RecoveryAttemptStore,
} from './recovery.service';
import type { PaymentProvider } from './payment.interface';

export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';
const PAYMENT_OPTIONS = Symbol('PAYMENT_OPTIONS');

export interface PaymentModuleOptions {
  providers?: PaymentProvider[];
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
      provide: PaymentService,
      inject: [PAYMENT_OPTIONS],
      useFactory: (options: PaymentModuleOptions) => {
        const service = new PaymentService();
        for (const provider of options.providers ?? []) service.register(provider);
        return service;
      },
    },
    OrderService,
    PaymentRecoveryService,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [PaymentService],
      useFactory: (service: PaymentService) => service.listProviders(),
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
      exports: [PaymentService, OrderService, PaymentRecoveryService],
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
      exports: [PaymentService, OrderService, PaymentRecoveryService],
    };
  }
}
