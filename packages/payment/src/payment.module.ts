import { Module, DynamicModule, Global, type Type, type InjectionToken } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { OrderService } from './order.service';
import { PaymentRecoveryService } from './recovery.service';
import type { PaymentProvider } from './payment.interface';

export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

export interface PaymentModuleOptions {
  providers?: PaymentProvider[];
}

export interface PaymentModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory: (...args: unknown[]) => PaymentModuleOptions | Promise<PaymentModuleOptions>;
  inject?: InjectionToken[];
}

@Global()
@Module({})
export class ZuckerPaymentModule {
  static forRoot(options: PaymentModuleOptions = {}): DynamicModule {
    return {
      module: ZuckerPaymentModule,
      providers: [
        PaymentService,
        OrderService,
        PaymentRecoveryService,
        {
          provide: PAYMENT_PROVIDERS,
          useFactory: (paymentService: PaymentService) => {
            for (const provider of options.providers ?? []) {
              paymentService.register(provider);
            }
            return paymentService.listProviders();
          },
          inject: [PaymentService],
        },
      ],
      exports: [PaymentService, OrderService, PaymentRecoveryService],
    };
  }

  static forRootAsync(options: PaymentModuleAsyncOptions): DynamicModule {
    return {
      module: ZuckerPaymentModule,
      imports: options.imports ?? [],
      providers: [
        PaymentService,
        OrderService,
        PaymentRecoveryService,
        {
          provide: PAYMENT_PROVIDERS,
          useFactory: async (paymentService: PaymentService, ...args: unknown[]) => {
            const factoryFn = options.useFactory;
            const moduleOptions = await factoryFn(...args);
            for (const provider of moduleOptions.providers ?? []) {
              paymentService.register(provider);
            }
            return paymentService.listProviders();
          },
          inject: [PaymentService, ...(options.inject ?? [])] as InjectionToken[],
        },
      ],
      exports: [PaymentService, OrderService, PaymentRecoveryService],
    };
  }
}
