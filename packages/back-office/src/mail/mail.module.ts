import { Global, Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { ZuckerMailModule } from '@zucker-framework/notification';
import { BackOfficeAccountMailer } from './account-mailer';
import { BillingReceiptMailer } from './billing-receipt';
import { BackOfficeMailTemplatePreviewer, MailTemplateSeeder, createMailAdminControllers } from './mail-admin';
import { BackOfficeMailTransport, SmtpTransport, type MailSettings, type MailSettingsSource } from './mail-transport';
import { resolveMailOptions, type BackOfficeMailOptions } from './mail.options';
import { MAIL_ACCOUNT_MAILER, MAIL_OPTIONS, MAIL_SETTINGS_SOURCE, MAIL_SITE } from './mail.tokens';
import { TransactionalMail } from './transactional-mail';

export interface BackOfficeMailModuleOptions extends BackOfficeMailOptions {
  /** Modules the `settings` / `site` classes need (registered with `useClass` here). */
  imports?: ModuleMetadata['imports'];
}

const UNCONFIGURED: MailSettings = Object.freeze({ transport: null,
  smtp: Object.freeze({ host: '', port: 587, secure: false, from: '', user: '', password: '' }) });
const unconfigured: MailSettingsSource = { now: () => UNCONFIGURED };

@Module({})
class BackOfficeMailTransportModule {}

/**
 * Global mail host: one `MailService` (`ZuckerMailModule`) with durable templates, the built-in
 * fallbacks and delivery history; the selecting SMTP / Resend transport over the consumer's
 * `MailSettingsSource`; `TransactionalMail`; and, per feature, the account mailer, receipt sender,
 * template seeding and the `management/email-*` admin controllers. Needs `DATABASE_ADAPTER`.
 * Build it once and import the same `DynamicModule` value wherever it is needed.
 */
@Global()
@Module({})
export class BackOfficeMailModule {
  static forRoot(input: BackOfficeMailModuleOptions = {}): DynamicModule {
    const { imports, ...rest } = input;
    const options = resolveMailOptions(rest);
    const transport: DynamicModule = {
      module: BackOfficeMailTransportModule,
      imports: imports ?? [],
      providers: [
        options.settings ? { provide: MAIL_SETTINGS_SOURCE, useClass: options.settings } : { provide: MAIL_SETTINGS_SOURCE, useValue: unconfigured },
        { provide: SmtpTransport, inject: [MAIL_SETTINGS_SOURCE],
          useFactory: (source: MailSettingsSource) => new SmtpTransport(() => source.now().smtp, source.refresh?.bind(source)) },
        { provide: BackOfficeMailTransport, inject: [SmtpTransport, MAIL_SETTINGS_SOURCE],
          useFactory: (smtp: SmtpTransport, source: MailSettingsSource) =>
            new BackOfficeMailTransport(smtp, () => source.now().transport, source.refresh?.bind(source)) },
      ],
      exports: [MAIL_SETTINGS_SOURCE, SmtpTransport, BackOfficeMailTransport],
    };
    const site: Provider[] = !options.site ? []
      : typeof options.site === 'function' ? [{ provide: MAIL_SITE, useClass: options.site }] : [{ provide: MAIL_SITE, useValue: options.site }];
    const features = options.features;
    return {
      module: BackOfficeMailModule,
      global: true,
      imports: [
        ...(imports ?? []),
        transport,
        ZuckerMailModule.forRootAsync({
          imports: [transport],
          inject: [DATABASE_ADAPTER, BackOfficeMailTransport],
          useFactory: (...args: unknown[]) => {
            const [database, provider] = args as [DatabaseAdapter, BackOfficeMailTransport];
            return {
              database,
              providers: [provider],
              historyModel: options.models.emailLogs,
              ...options.delivery,
              templates: { model: options.models.emailTemplates, defaultLocale: options.defaultLocale, contentFields: { ...options.contentFields },
                builtIns: [...options.builtIns] },
            };
          },
        }),
      ],
      controllers: features.admin ? createMailAdminControllers(options) : [],
      providers: [
        { provide: MAIL_OPTIONS, useValue: options },
        ...site,
        TransactionalMail,
        ...(features.admin ? [BackOfficeMailTemplatePreviewer] : []),
        ...(features.accountMailer ? [BackOfficeAccountMailer, { provide: MAIL_ACCOUNT_MAILER, useExisting: BackOfficeAccountMailer }] : []),
        ...(features.receipts ? [BillingReceiptMailer] : []),
        ...(features.seedTemplates ? [MailTemplateSeeder] : []),
      ],
      exports: [
        MAIL_OPTIONS, TransactionalMail, transport,
        ...(features.accountMailer ? [BackOfficeAccountMailer, MAIL_ACCOUNT_MAILER] : []),
        ...(features.receipts ? [BillingReceiptMailer] : []),
      ],
    };
  }

  /**
   * Only the admin controllers, for a consumer that mounts them in a separate module while the core
   * `forRoot` module is imported elsewhere (the core must be present; it is global).
   */
  static adminControllers(input: BackOfficeMailOptions = {}): DynamicModule {
    return { module: BackOfficeMailAdminModule, controllers: createMailAdminControllers(resolveMailOptions(input)), providers: [BackOfficeMailTemplatePreviewer] };
  }
}

@Module({})
class BackOfficeMailAdminModule {}
