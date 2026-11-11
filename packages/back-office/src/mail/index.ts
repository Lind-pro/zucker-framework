// Public surface of `@zucker-framework/back-office/mail` (work package F5).
export { BackOfficeMailModule } from './mail.module';
export type { BackOfficeMailModuleOptions } from './mail.module';
export {
  DEFAULT_MAIL_LINKS,
  DEFAULT_MAIL_MODELS,
  DEFAULT_MAIL_TABLES,
  resolveMailOptions,
} from './mail.options';
export type {
  BackOfficeMailOptions,
  MailLinkKey,
  MailModelKey,
  MailSitePort,
  MailTableKey,
  ResolvedMailOptions,
} from './mail.options';
export { MAIL_ACCOUNT_MAILER, MAIL_OPTIONS, MAIL_SETTINGS_SOURCE, MAIL_SITE } from './mail.tokens';
export {
  ACCOUNT_MAIL_TEMPLATES,
  BACK_OFFICE_MAIL_TEMPLATES,
  DEFAULT_MAIL_SUBJECTS,
  MAIL_TEMPLATE_KEYS,
  VERIFICATION_CODE_MAIL_KEY,
  VERIFICATION_CODE_MAIL_TEMPLATE,
  defaultMailSubject,
  mailLocale,
} from './mail-templates';
export type { MailLocale, MailTemplateKey } from './mail-templates';
export {
  BackOfficeMailTransport,
  LeasedProvider,
  MAIL_TRANSPORT_KINDS,
  SMTP_PRESETS,
  SmtpTransport,
  mailSettingsFromConnection,
  mailTransportSettingsFromConnection,
  smtpSettingsFromConnection,
  smtpSettingsFromPreset,
} from './mail-transport';
export type {
  MailSettings,
  MailSettingsSource,
  MailTransportKind,
  MailTransportSettings,
  SmtpPreset,
  SmtpSettings,
} from './mail-transport';
export { TransactionalMail } from './transactional-mail';
export type { TransactionalMailMessage } from './transactional-mail';
export { BackOfficeAccountMailer } from './account-mailer';
export type { AccountMailPurpose, AccountMailerPort } from './account-mailer';
export { BillingReceiptMailer, deliverBillingReceipt } from './billing-receipt';
export type { ReceiptOutcome } from './billing-receipt';
export {
  BackOfficeMailTemplatePreviewer,
  MailTemplateSeeder,
  createMailAdminControllers,
  seedMailTemplates,
} from './mail-admin';
