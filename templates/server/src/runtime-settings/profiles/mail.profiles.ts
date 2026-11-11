import { DURABLE_EMAIL_CONNECTION_DESCRIPTOR } from '@zucker-framework/notification';
import { deliveryOptionsFromEnvironment } from '../../delivery/delivery.config';
import { ACCOUNT_EMAIL_CONNECTION_PROFILE } from '../../mail/mail.profiles';
import { connectionSdkAvailable } from '../connection-sdk';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../registry';

const label = (text: string) => ({ label: text });
export const MAIL_CONNECTION_PROFILES = [
  // Account and transactional mail (SMTP or Resend) is owned by the mail feature.
  ACCOUNT_EMAIL_CONNECTION_PROFILE,
  // Hot: `DeliveryModule` rebuilds the durable provider on save; a delivery in progress keeps its client.
  defineConnectionProfile({ applyMode: 'hot',
    validate: async env => {
      if (env.DELIVERY_PROVIDER === 'resend' && !connectionSdkAvailable('@zucker-framework/notification', 'resend')) throw new Error('resend');
      const options = deliveryOptionsFromEnvironment(env); await options.provider?.close();
    },
    profile: localizeConnectionDescriptor(DURABLE_EMAIL_CONNECTION_DESCRIPTOR, { name: '任务通知邮件', category: '邮件', fields: {
      DELIVERY_PROVIDER: label('渠道'), DELIVERY_ACCOUNT_SCOPE: label('账户标识'), DELIVERY_FROM: label('发件人'), DELIVERY_RESEND_API_KEY: label('Resend API 密钥'),
      DELIVERY_SMTP_HOST: label('SMTP 主机'), DELIVERY_SMTP_PORT: label('端口'), DELIVERY_SMTP_SECURE: label('使用 TLS'),
      DELIVERY_SMTP_USER: label('SMTP 用户名'), DELIVERY_SMTP_PASSWORD: label('SMTP 密码') } }) }),
];
