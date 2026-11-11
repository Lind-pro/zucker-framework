import { ACCOUNT_EMAIL_CONNECTION_DESCRIPTOR, EmailProvider } from '@zucker-framework/notification';
import { oauthSettings } from '../oauth/oauth.config';
import { connectionSdkAvailable } from '../runtime-settings/connection-sdk';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../runtime-settings/registry';
import { mailTransportSettingsFromConnection, smtpSettingsFromConnection } from './mail-transport';

const label = (text: string) => ({ label: text });

/**
 * `account-email`: the transport of account and transactional mail (MailService). `MAIL_PROVIDER`
 * chooses SMTP (default, unchanged fields) or Resend (`MAIL_RESEND_API_KEY`); `SMTP_FROM` is the
 * sender for both. Hot-applied: `SmtpTransportModule` reads it through a `HotProvider`, so a save
 * changes where the next mail goes; a send already in progress finishes on the previous transport.
 * Fields come from the `@zucker-framework/notification` descriptor (ids and keys are a storage contract).
 */
export const ACCOUNT_EMAIL_CONNECTION_PROFILE = defineConnectionProfile({ applyMode: 'hot',
  validate: async env => {
    const transport = mailTransportSettingsFromConnection(env);
    if (!transport) throw new Error('provider');
    if (transport.kind === 'resend') {
      if (!transport.from || !transport.resendApiKey || !env.WEB_URL) throw new Error('resend');
      if (!connectionSdkAvailable('@zucker-framework/notification', 'resend')) throw new Error('resend-sdk');
      oauthSettings(env);
      return;
    }
    if (!env.SMTP_HOST && !env.SMTP_FROM && !env.SMTP_USER && !env.SMTP_PASSWORD) return;
    // Same parsing as the shared SmtpTransport behind MailService.
    const smtp = smtpSettingsFromConnection(env);
    if (!smtp.host || !smtp.from || !env.WEB_URL || !Number.isSafeInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) throw new Error('smtp');
    oauthSettings(env);
    const provider = new EmailProvider({ host: smtp.host, from: smtp.from, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.password } });
    try { if (!provider.isConfigured()) throw new Error('smtp'); } finally { await provider.close(); }
  },
  profile: localizeConnectionDescriptor(ACCOUNT_EMAIL_CONNECTION_DESCRIPTOR, { name: '账户邮件', category: '邮件', fields: {
    MAIL_PROVIDER: label('发送渠道'), SMTP_FROM: label('发件人'), SMTP_HOST: label('SMTP 主机'), SMTP_PORT: label('端口'),
    SMTP_SECURE: label('使用 TLS'), SMTP_USER: label('SMTP 用户名'), SMTP_PASSWORD: label('SMTP 密码'), MAIL_RESEND_API_KEY: label('Resend API 密钥') } }) });
