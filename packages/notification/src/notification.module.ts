import {
  Module,
  DynamicModule,
  Global,
  Inject,
  OnModuleDestroy,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { TemplateService } from './template.service';
import { EmailProvider, EmailNotifierProvider } from './providers/email';
import type { EmailProviderOptions } from './providers/email';
import { WebhookProvider, WebhookNotifierProvider } from './providers/webhook';
import type { WebhookProviderOptions } from './providers/webhook';
import { SmsNotifierAdapter } from './providers/sms-notifier';
import { SmsNotifierProvider } from './providers/sms/sms-notifier.provider';
import { AliyunSmsProvider } from './providers/sms/aliyun-sms.provider';
import type { AliyunSmsOptions } from './providers/sms/aliyun-sms.provider';
import { TencentSmsProvider } from './providers/sms/tencent-sms.provider';
import type { TencentSmsOptions } from './providers/sms/tencent-sms.provider';
import type { SimpleNotifierProvider, NotifierProvider, NotifyChannel } from './notifier.interface';
import { CompositeNotifierService } from './composite-notifier.service';
import { NotifierManagerService } from './notifier-manager.service';
import { NotifyHistoryService } from './notify-history.service';
import { NotificationRetryService } from './retry/notification-retry.service';
import {
  NOTIFIER_PROVIDERS,
  NOTIFIER_PROVIDER_REGISTRY,
  NOTIFY_CONFIG_MANAGER,
  TOPIC_EVENT_BUS_TOKEN,
} from './notification.tokens';

export { NOTIFIER_PROVIDERS, NOTIFIER_PROVIDER_REGISTRY, NOTIFY_CONFIG_MANAGER, TOPIC_EVENT_BUS_TOKEN };

export type SmsProviderType = 'aliyun' | 'tencent';

export interface NotificationModuleOptions {
  providers: Array<
    | { channel: 'EMAIL'; options: EmailProviderOptions }
    | { channel: 'WEBHOOK'; options?: WebhookProviderOptions }
    | { channel: 'SMS'; smsProvider: 'aliyun'; options: AliyunSmsOptions }
    | { channel: 'SMS'; smsProvider: 'tencent'; options: TencentSmsOptions }
  >;
  /** Enable notification history tracking (in-memory by default) */
  enableHistory?: boolean;
}

export interface NotificationModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => NotificationModuleOptions | Promise<NotificationModuleOptions>;
  useClass?: Type<NotificationModuleOptionsFactory>;
  useExisting?: Type<NotificationModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface NotificationModuleOptionsFactory {
  createNotificationOptions(): NotificationModuleOptions | Promise<NotificationModuleOptions>;
}

const NOTIFICATION_MODULE_OPTIONS = Symbol('NOTIFICATION_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerNotificationModule implements OnModuleDestroy {
  constructor(
    @Inject(NotifierManagerService)
    private readonly notifierManager: NotifierManagerService,
  ) {}

  static forRoot(options: NotificationModuleOptions): DynamicModule {
    const enableHistory = options.enableHistory ?? true;

    const providers: Provider[] = [
      TemplateService,
      CompositeNotifierService,
      NotificationRetryService,
      {
        provide: NOTIFIER_PROVIDERS,
        useFactory: (): SimpleNotifierProvider[] =>
          ZuckerNotificationModule.createNotifierProviders(options),
      },
      // NotifierProvider registry for the NotifierManager pattern
      {
        provide: NOTIFIER_PROVIDER_REGISTRY,
        useFactory: (): NotifierProvider[] => {
          return [new EmailNotifierProvider(), new WebhookNotifierProvider(), new SmsNotifierProvider()];
        },
      },
      NotifierManagerService,
    ];

    const exports: Array<Provider | string | symbol> = [
      TemplateService,
      NOTIFIER_PROVIDERS,
      NOTIFIER_PROVIDER_REGISTRY,
      CompositeNotifierService,
      NotifierManagerService,
      NotificationRetryService,
    ];

    if (enableHistory) {
      providers.push(NotifyHistoryService);
      exports.push(NotifyHistoryService);
    }

    return {
      module: ZuckerNotificationModule,
      providers,
      exports,
    };
  }

  static forRootAsync(options: NotificationModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerNotificationModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        TemplateService,
        CompositeNotifierService,
        NotificationRetryService,
        {
          provide: NOTIFIER_PROVIDERS,
          useFactory: (opts: NotificationModuleOptions): SimpleNotifierProvider[] =>
            ZuckerNotificationModule.createNotifierProviders(opts),
          inject: [NOTIFICATION_MODULE_OPTIONS],
        },
        {
          provide: NOTIFIER_PROVIDER_REGISTRY,
          useFactory: (): NotifierProvider[] => {
            return [new EmailNotifierProvider(), new WebhookNotifierProvider(), new SmsNotifierProvider()];
          },
        },
        NotifierManagerService,
        // forRootAsync 与 forRoot 保持一致：始终注册 NotifyHistoryService
        NotifyHistoryService,
      ],
      exports: [
        TemplateService,
        NOTIFIER_PROVIDERS,
        NOTIFIER_PROVIDER_REGISTRY,
        CompositeNotifierService,
        NotifierManagerService,
        NotifyHistoryService,
        NotificationRetryService,
      ],
    };
  }

  private static createNotifierProviders(options: NotificationModuleOptions): SimpleNotifierProvider[] {
    return options.providers.map((p) => {
      switch (p.channel) {
        case 'EMAIL':
          return new EmailProvider(p.options);
        case 'WEBHOOK':
          return new WebhookProvider(p.options);
        case 'SMS': {
          const smsProvider =
            p.smsProvider === 'aliyun'
              ? new AliyunSmsProvider(p.options as AliyunSmsOptions)
              : new TencentSmsProvider(p.options as TencentSmsOptions);
          return new SmsNotifierAdapter(smsProvider);
        }
        default: {
          const _exhaustive: never = p;
          throw new Error(`Unsupported notification channel: ${(_exhaustive as { channel: string }).channel}`);
        }
      }
    });
  }

  private static createAsyncProviders(options: NotificationModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: NOTIFICATION_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: NOTIFICATION_MODULE_OPTIONS,
      useFactory: async (factory: NotificationModuleOptionsFactory) => factory.createNotificationOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }

  async onModuleDestroy(): Promise<void> {
    // Clean up notifier resources on module shutdown
    await this.notifierManager.closeAll();
  }
}
