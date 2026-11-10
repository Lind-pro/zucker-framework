import { deliveryOptionsFromEnvironment } from '../../delivery/delivery.config';
import { ACCOUNT_EMAIL_CONNECTION_PROFILE } from '../../mail/mail.profiles';
import { connectionSdkAvailable } from '../connection-sdk';
import { connectionField, defineConnectionProfile } from '../registry';

const { boolean, port, secret, select, text } = connectionField;
export const MAIL_CONNECTION_PROFILES = [
  // Account and transactional mail (SMTP or Resend) is owned by the mail feature.
  ACCOUNT_EMAIL_CONNECTION_PROFILE,
  defineConnectionProfile({ applyMode: 'restart',
    validate: async env => {
      if (env.DELIVERY_PROVIDER === 'resend' && !connectionSdkAvailable('@zucker-framework/notification', 'resend')) throw new Error('resend');
      const options = deliveryOptionsFromEnvironment(env); await options.provider?.close();
    },
    profile: { id: 'durable-email', name: '任务通知邮件', category: '邮件', fields: [select('DELIVERY_PROVIDER', '渠道', ['none', 'smtp', 'resend'], 'none'),
      text('DELIVERY_ACCOUNT_SCOPE', '账户标识'), text('DELIVERY_FROM', '发件人'), secret('DELIVERY_RESEND_API_KEY', 'Resend API 密钥'),
      text('DELIVERY_SMTP_HOST', 'SMTP 主机'), port('DELIVERY_SMTP_PORT'), boolean('DELIVERY_SMTP_SECURE', '使用 TLS'),
      text('DELIVERY_SMTP_USER', 'SMTP 用户名'), secret('DELIVERY_SMTP_PASSWORD', 'SMTP 密码')] } }),
];
