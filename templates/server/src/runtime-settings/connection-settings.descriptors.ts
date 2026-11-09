import { BadRequestException } from '@nestjs/common';
import { EmailProvider } from '@zucker-framework/notification';
import { configuredBillingProviders } from '../billing/providers';
import { deliveryOptionsFromEnvironment } from '../delivery/delivery.config';
import { storageOptionsFromEnvironment } from '../files/files.config';
import { oauthSettings } from '../oauth/oauth.config';
import { connectionSdkAvailable } from './connection-sdk';
import { siteAnalyticsConfig, siteConnectionsConfig, validatePublicAnalytics, validatePublicConnections } from './site-public.config';
import { AI_CONNECTIONS, validateAIConnection } from '../ai-connections/ai-connections.config';
import { smtpSettingsFromConnection } from '../mail/smtp-transport';

export type ConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface ConnectionField {
  key: string; label: string; type: ConnectionFieldType; options?: readonly string[]; defaultValue?: string; description?: string; min?: number; max?: number;
}
export interface ConnectionProfile { id: string; name: string; category: string; fields: readonly ConnectionField[] }
const text = (key: string, label: string): ConnectionField => ({ key, label, type: 'text' });
const secret = (key: string, label: string): ConnectionField => ({ key, label, type: 'secret' });
const boolean = (key: string, label: string, defaultValue = 'false'): ConnectionField => ({ key, label, type: 'boolean', defaultValue });
const select = (key: string, label: string, options: string[], defaultValue?: string): ConnectionField => ({ key, label, type: 'select', options, defaultValue });
const port = (key: string): ConnectionField => ({ key, label: '端口', type: 'number', defaultValue: '587', min: 1, max: 65535 });
export const CONNECTION_PROFILES: readonly ConnectionProfile[] = [
  ...AI_CONNECTIONS.map(connection => ({ id: connection.id, name: connection.name, category: 'AI', fields: [
    boolean(`${connection.prefix}_ENABLED`, '启用'), secret(`${connection.prefix}_API_KEY`, 'API 密钥'), text(`${connection.prefix}_MODEL_ID`, '模型 ID'),
    { key: `${connection.prefix}_BASE_URL`, label: 'API 地址', type: 'url' as const, defaultValue: connection.baseURL, description: 'HTTPS 地址，不含用户名、查询参数或片段；兼容接口必须明确填写。' },
    { key: `${connection.prefix}_MAX_TOKENS`, label: '最大输出 Token', type: 'number' as const, min: 1, max: 1048576, description: 'Anthropic 必填；其他连接可由具体调用声明。仍需遵循所选模型的限制。' },
    { key: `${connection.prefix}_TIMEOUT_MS`, label: '超时（毫秒）', type: 'number' as const, defaultValue: '60000', min: 1, max: 600000 },
  ] })),
  { id: 'web-analytics', name: '网站分析', category: '公开站点', fields: [boolean('SITE_ANALYTICS_ENABLED', '启用网站分析'),
    boolean('GOOGLE_ANALYTICS_ENABLED', 'Google Analytics'), text('GOOGLE_ANALYTICS_MEASUREMENT_ID', 'GA4 Measurement ID'),
    boolean('CLARITY_ENABLED', 'Microsoft Clarity'), text('CLARITY_PROJECT_ID', 'Clarity Project ID'),
    boolean('PLAUSIBLE_ENABLED', 'Plausible'), { ...text('PLAUSIBLE_SCRIPT_URL', 'Plausible 安装脚本地址'), description: 'HTTPS 或同源脚本路径，可包含站点安装参数。' },
    boolean('OPENPANEL_ENABLED', 'OpenPanel'), text('OPENPANEL_CLIENT_ID', 'OpenPanel 公开 Client ID'),
    { ...text('OPENPANEL_API_URL', 'OpenPanel API 地址'), description: '可选 HTTPS 或同源地址；不得填写 Client Secret。' },
    boolean('VERCEL_ANALYTICS_ENABLED', 'Vercel Analytics'), { ...text('VERCEL_ANALYTICS_SCRIPT_PATH', 'Vercel 安装脚本路径'), description: '填写该项目提供的同源脚本路径。' }] },
  { id: 'web-connections', name: '网站广告、联盟与客服', category: '公开站点', fields: [boolean('SITE_CONNECTIONS_ENABLED', '启用网站连接'),
    boolean('ADSENSE_ENABLED', 'Google AdSense'), text('ADSENSE_PUBLISHER_ID', 'AdSense 公开 Publisher ID'),
    boolean('AFFONSO_ENABLED', 'Affonso'), text('AFFONSO_PROGRAM_ID', 'Affonso 公开 Program ID'),
    { key: 'AFFONSO_COOKIE_DURATION_DAYS', label: 'Affonso Cookie 天数', type: 'number', description: '启用 Affonso 时必填；以该服务允许的时长为准。' },
    boolean('PROMOTEKIT_ENABLED', 'PromoteKit'), text('PROMOTEKIT_PROGRAM_ID', 'PromoteKit 公开 Program ID'),
    boolean('CRISP_ENABLED', 'Crisp'), text('CRISP_WEBSITE_ID', 'Crisp Website ID'),
    boolean('TAWK_ENABLED', 'tawk.to'), text('TAWK_PROPERTY_ID', 'tawk.to Property ID'), text('TAWK_WIDGET_ID', 'tawk.to Widget ID')] },
  { id: 'payment-stripe', name: 'Stripe', category: '支付', fields: [boolean('BILLING_STRIPE_ENABLED', '启用'), select('BILLING_STRIPE_MODE', '模式', ['test', 'live']),
    text('BILLING_STRIPE_ACCOUNT_SCOPE', '账户标识'), secret('STRIPE_SECRET_KEY', 'API 密钥'), secret('STRIPE_WEBHOOK_SECRET', 'Webhook 签名密钥')] },
  { id: 'payment-paypal', name: 'PayPal', category: '支付', fields: [boolean('BILLING_PAYPAL_ENABLED', '启用'), select('BILLING_PAYPAL_MODE', '模式', ['sandbox', 'live']),
    text('BILLING_PAYPAL_ACCOUNT_SCOPE', '账户标识'), text('PAYPAL_CLIENT_ID', 'Client ID'), secret('PAYPAL_CLIENT_SECRET', 'Client Secret'), text('PAYPAL_WEBHOOK_ID', 'Webhook ID')] },
  { id: 'payment-creem', name: 'Creem', category: '支付', fields: [boolean('BILLING_CREEM_ENABLED', '启用'), select('BILLING_CREEM_MODE', '模式', ['test', 'production']),
    text('BILLING_CREEM_ACCOUNT_SCOPE', '账户标识'), secret('CREEM_API_KEY', 'API 密钥'), secret('CREEM_WEBHOOK_SECRET', 'Webhook 签名密钥')] },
  { id: 'identity-google', name: 'Google 登录', category: '登录', fields: [boolean('GOOGLE_OAUTH_ENABLED', 'OAuth 登录'), boolean('GOOGLE_ONE_TAP_ENABLED', 'One Tap'),
    text('GOOGLE_CLIENT_ID', 'Client ID'), secret('GOOGLE_CLIENT_SECRET', 'Client Secret')] },
  { id: 'identity-github', name: 'GitHub 登录', category: '登录', fields: [boolean('GITHUB_OAUTH_ENABLED', '启用'), text('GITHUB_CLIENT_ID', 'Client ID'), secret('GITHUB_CLIENT_SECRET', 'Client Secret')] },
  { id: 'account-email', name: '账户邮件（SMTP）', category: '邮件', fields: [text('SMTP_HOST', 'SMTP 主机'), port('SMTP_PORT'), boolean('SMTP_SECURE', '使用 TLS'),
    text('SMTP_FROM', '发件人'), text('SMTP_USER', 'SMTP 用户名'), secret('SMTP_PASSWORD', 'SMTP 密码')] },
  { id: 'durable-email', name: '任务通知邮件', category: '邮件', fields: [select('DELIVERY_PROVIDER', '渠道', ['none', 'smtp', 'resend'], 'none'),
    text('DELIVERY_ACCOUNT_SCOPE', '账户标识'), text('DELIVERY_FROM', '发件人'), secret('DELIVERY_RESEND_API_KEY', 'Resend API 密钥'),
    text('DELIVERY_SMTP_HOST', 'SMTP 主机'), port('DELIVERY_SMTP_PORT'), boolean('DELIVERY_SMTP_SECURE', '使用 TLS'),
    text('DELIVERY_SMTP_USER', 'SMTP 用户名'), secret('DELIVERY_SMTP_PASSWORD', 'SMTP 密码')] },
  { id: 'private-files', name: '私有文件存储（S3 / R2）', category: '存储', fields: [select('FILES_STORAGE_PROVIDER', '存储类型', ['local', 's3'], 'local'),
    text('FILES_S3_BUCKET', 'Bucket'), { ...text('FILES_S3_REGION', 'Region'), defaultValue: 'us-east-1' }, { key: 'FILES_S3_ENDPOINT', label: '兼容 S3 的 Endpoint', type: 'url' },
    secret('FILES_S3_ACCESS_KEY_ID', 'Access Key ID'), secret('FILES_S3_SECRET_ACCESS_KEY', 'Secret Access Key'), { key: 'FILES_S3_FORCE_PATH_STYLE', label: '使用 Path Style（留空时按 Endpoint 选择）', type: 'boolean' }] },
];
const CATEGORY_KEYS: Readonly<Record<string, string>> = { AI: 'ai', '公开站点': 'public-site', '支付': 'payments', '登录': 'sign-in', '邮件': 'mail', '存储': 'storage' };
/**
 * Stable translation keys sent next to the display text (`labelKey` and friends), so clients
 * translate by key instead of by the exact Chinese wording. AI fields share keys across providers.
 */
export function connectionLabelKeys(profile: ConnectionProfile) {
  const prefix = AI_CONNECTIONS.find(connection => connection.id === profile.id)?.prefix;
  const fieldKey = (field: ConnectionField) =>
    `connections.field.${prefix && field.key.startsWith(`${prefix}_`) ? `AI_${field.key.slice(prefix.length + 1)}` : field.key}`;
  return {
    labelKey: `connections.${profile.id}`,
    categoryKey: `connections.category.${CATEGORY_KEYS[profile.category] ?? profile.category.toLowerCase()}`,
    field: (field: ConnectionField) => ({ labelKey: fieldKey(field), ...(field.description ? { descriptionKey: `${fieldKey(field)}.description` } : {}) }),
  };
}
export function connectionProfile(id: string): ConnectionProfile {
  const profile = CONNECTION_PROFILES.find(row => row.id === id); if (!profile) throw new BadRequestException('Unknown connection profile'); return profile;
}
export function validateField(field: ConnectionField, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > (field.type === 'secret' ? 16384 : 2048) || /[\u0000-\u001f\u007f]/.test(value)) throw new BadRequestException(`Invalid ${field.key}; use an explicit clear action to remove a value`);
  if (field.type === 'boolean' && !['true', 'false'].includes(value) || field.type === 'select' && !field.options?.includes(value)) throw new BadRequestException(`Invalid ${field.key} choice`);
  if (field.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (field.min ?? 1) || Number(value) > (field.max ?? Number.MAX_SAFE_INTEGER))) throw new BadRequestException(`Invalid ${field.key} number`);
  if (field.type === 'url') {
    try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { throw new BadRequestException(`Invalid ${field.key} URL`); }
  }
  return field.type === 'secret' ? value : value.trim();
}
/** Construct local options only. No verification request, send, upload or payment is performed. */
export async function validateConnection(profile: ConnectionProfile, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (profile.id.startsWith('ai-')) await validateAIConnection(profile.id, env);
    else if (profile.id === 'web-analytics') validatePublicAnalytics(siteAnalyticsConfig(env));
    else if (profile.id === 'web-connections') validatePublicConnections(siteConnectionsConfig(env));
    else if (profile.id.startsWith('payment-')) {
      const id = profile.id.slice('payment-'.length);
      configuredBillingProviders({ ...env, BILLING_STRIPE_ENABLED: id === 'stripe' ? env.BILLING_STRIPE_ENABLED : 'false',
        BILLING_PAYPAL_ENABLED: id === 'paypal' ? env.BILLING_PAYPAL_ENABLED : 'false', BILLING_CREEM_ENABLED: id === 'creem' ? env.BILLING_CREEM_ENABLED : 'false' });
    } else if (profile.id.startsWith('identity-')) {
      const id = profile.id.slice('identity-'.length), settings = oauthSettings(env);
      if (id === 'google' && (env.GOOGLE_OAUTH_ENABLED === 'true' && !settings.google.code || env.GOOGLE_ONE_TAP_ENABLED === 'true' && !settings.google.oneTap)
        || id === 'github' && env.GITHUB_OAUTH_ENABLED === 'true' && !settings.github.code) throw new Error();
    } else if (profile.id === 'durable-email') {
      if (env.DELIVERY_PROVIDER === 'resend' && !connectionSdkAvailable('@zucker-framework/notification', 'resend')) throw new Error();
      const options = deliveryOptionsFromEnvironment(env); await options.provider?.close();
    } else if (profile.id === 'private-files') {
      if (env.FILES_STORAGE_PROVIDER === 's3' && !connectionSdkAvailable('@zucker-framework/storage', '@aws-sdk/client-s3')) throw new Error();
      storageOptionsFromEnvironment(env);
    }
    else if (profile.id === 'account-email') {
      if (!env.SMTP_HOST && !env.SMTP_FROM && !env.SMTP_USER && !env.SMTP_PASSWORD) return;
      // Same parsing as the shared SmtpTransport that account mail and MailService use.
      const smtp = smtpSettingsFromConnection(env);
      if (!smtp.host || !smtp.from || !env.WEB_URL || !Number.isSafeInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) throw new Error();
      oauthSettings(env);
      const provider = new EmailProvider({ host: smtp.host, from: smtp.from, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.password } });
      try { if (!provider.isConfigured()) throw new Error(); } finally { await provider.close(); }
    }
  } catch { throw new BadRequestException('Connection configuration cannot be assembled locally; check required fields and installed provider support'); }
}
