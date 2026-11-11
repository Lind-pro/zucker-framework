// The selecting SMTP / Resend transport lives in `@zucker-framework/back-office/mail`.
export {
  BackOfficeMailTransport as ApplicationMailTransport,
  LeasedProvider,
  MAIL_TRANSPORT_KINDS,
  mailTransportSettingsFromConnection,
  smtpSettingsFromConnection,
  type MailTransportKind,
  type MailTransportSettings,
  type SmtpSettings,
} from '@zucker-framework/back-office/mail';
