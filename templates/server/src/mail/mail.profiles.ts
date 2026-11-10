import { EmailProvider } from '@zucker-framework/notification';
import { oauthSettings } from '../oauth/oauth.config';
import { connectionSdkAvailable } from '../runtime-settings/connection-sdk';
import { connectionField, defineConnectionProfile } from '../runtime-settings/registry';
import { MAIL_TRANSPORT_KINDS, mailTransportSettingsFromConnection } from './mail-transport';
import { smtpSettingsFromConnection } from './smtp-transport';

const { boolean, port, secret, select, text } = connectionField;

/**
 * `account-email`: the transport of account and transactional mail (MailService). `MAIL_PROVIDER`
 * chooses SMTP (default, unchanged fields) or Resend (`MAIL_RESEND_API_KEY`); `SMTP_FROM` is the
 * sender for both. Restart-to-apply like the other provider credentials (decision D1).
 */
export const ACCOUNT_EMAIL_CONNECTION_PROFILE = defineConnectionProfile({ applyMode: 'restart',
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
  profile: { id: 'account-email', name: '账户邮件', category: '邮件', fields: [
    select('MAIL_PROVIDER', '发送渠道', [...MAIL_TRANSPORT_KINDS], 'smtp'),
    text('SMTP_FROM', '发件人'),
    text('SMTP_HOST', 'SMTP 主机'), port('SMTP_PORT'), boolean('SMTP_SECURE', '使用 TLS'),
    text('SMTP_USER', 'SMTP 用户名'), secret('SMTP_PASSWORD', 'SMTP 密码'),
    secret('MAIL_RESEND_API_KEY', 'Resend API 密钥'),
  ] } });
