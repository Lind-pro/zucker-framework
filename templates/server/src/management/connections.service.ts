import { Inject, Injectable, Optional } from '@nestjs/common';
import { AIConfigService, AIProviderManager } from '@zucker-framework/ai';
import { EmailProvider } from '@zucker-framework/notification';
import { configuredBillingProviders } from '../billing/providers';
import { readBillingCatalog } from '../billing/catalog';
import { deliveryOptionsFromEnvironment } from '../delivery/delivery.config';
import { mailTransportSettingsFromConnection } from '../mail/mail-transport';
import { storageOptionsFromEnvironment } from '../files/files.config';
import { oauthSettings } from '../oauth/oauth.config';
import { inspectAIConnections } from '../ai-connections/ai-connections.config';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { connectionSdkAvailable } from '../runtime-settings/connection-sdk';
import { hotConnectionStatus } from '@zucker-framework/back-office/settings';
import {
  siteAnalyticsConfig,
  siteConnectionsConfig,
  validatePublicAnalytics,
  validatePublicConnections,
} from '../runtime-settings/site-public.config';
export { connectionSdkAvailable } from '../runtime-settings/connection-sdk';

export const MANAGEMENT_CONNECTION_ENV = Symbol('MANAGEMENT_CONNECTION_ENV');
export interface ConnectionStatus {
  id: string;
  name: string;
  category: string;
  source: 'server-environment' | 'web-environment' | 'runtime-registration' | 'runtime-snapshot';
  status:
    | 'configured'
    | 'disabled'
    | 'missing'
    | 'invalid'
    | 'missing-sdk'
    | 'managed-elsewhere'
    | 'not-registered';
  enabled: boolean | null;
  missing: string[];
  sdkAvailable: boolean | null;
  mode?: string;
  note: string;
  configuredOfferCount?: number;
  storedRevision?: number;
  appliedRevision?: number;
  pendingRestart?: boolean;
  /** `hot`: a save applies to the next request; `restart`: on the next server start. Only with runtime settings. */
  applyMode?: 'hot' | 'restart';
  /**
   * Hot profiles only: the newest saved revision could not be assembled into a provider, so
   * `appliedRevision` (an older revision) keeps serving. Revision numbers only, never details.
   */
  applyError?: { revision: number; reason: 'provider_assembly_failed' };
  registeredProviderIds?: string[];
  configurationSourceIds?: string[];
}
const paymentKeys = {
  stripe: [
    'BILLING_STRIPE_MODE',
    'BILLING_STRIPE_ACCOUNT_SCOPE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ],
  paypal: [
    'BILLING_PAYPAL_MODE',
    'BILLING_PAYPAL_ACCOUNT_SCOPE',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ],
  creem: [
    'BILLING_CREEM_MODE',
    'BILLING_CREEM_ACCOUNT_SCOPE',
    'CREEM_API_KEY',
    'CREEM_WEBHOOK_SECRET',
  ],
} as const;
function base(
  id: string,
  name: string,
  category: string,
  enabled: boolean,
  missing: string[],
  sdkAvailable = true,
): ConnectionStatus {
  return {
    id,
    name,
    category,
    enabled,
    missing,
    sdkAvailable,
    source: 'server-environment',
    status: !enabled
      ? 'disabled'
      : missing.length
        ? 'missing'
        : !sdkAvailable
          ? 'missing-sdk'
          : 'configured',
    note: RESTART_NOTE,
  };
}
const RESTART_NOTE = '仅校验本地配置与依赖；未连接外部服务。环境配置修改后需重启服务。';
const HOT_NOTE = '仅校验本地配置与依赖；未连接外部服务。保存后的设置从下一次请求起生效（其他服务实例在 30 秒内生效），进行中的发送、上传或对话仍使用原设置完成；进程环境变量修改后仍需重启服务。';

/** Metadata only: use the application's actual config parsers, never verify/send/query a provider. */
@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(MANAGEMENT_CONNECTION_ENV) private readonly env: NodeJS.ProcessEnv,
    @Optional() private readonly ai?: AIProviderManager,
    @Optional() private readonly aiConfig?: AIConfigService,
    @Optional() private readonly settings?: ConnectionSettingsService,
  ) {}
  async inspect(): Promise<{
    connections: ConnectionStatus[];
    checkedAt: string;
    externalRequests: false;
  }> {
    // With runtime settings, hot profiles are inspected at their current stored revision (what the
    // next request uses); restart profiles stay at the start-up snapshot (what is applied).
    const env = this.settings ? (await this.settings.liveEnvironment()).environment : this.env,
      rows: ConnectionStatus[] = [],
      missing = (keys: readonly string[]) => keys.filter((key) => !env[key]?.trim());
    for (const id of ['stripe', 'paypal', 'creem'] as const) {
      const enabled = env[`BILLING_${id.toUpperCase()}_ENABLED`] === 'true';
      const sdk =
        id === 'creem' ||
        connectionSdkAvailable(
          '@zucker-framework/payment',
          id === 'stripe' ? 'stripe' : '@paypal/paypal-server-sdk',
        );
      const row = base(
        `payment-${id}`,
        { stripe: 'Stripe', paypal: 'PayPal', creem: 'Creem' }[id],
        '支付',
        enabled,
        enabled ? missing(paymentKeys[id]) : [],
        sdk,
      );
      if (row.status === 'configured') {
        try {
          const providers = configuredBillingProviders({
            ...env,
            BILLING_STRIPE_ENABLED: id === 'stripe' ? 'true' : 'false',
            BILLING_PAYPAL_ENABLED: id === 'paypal' ? 'true' : 'false',
            BILLING_CREEM_ENABLED: id === 'creem' ? 'true' : 'false',
          });
          if (!providers.checkouts.some((provider) => provider.id === id)) throw new Error();
          row.configuredOfferCount = readBillingCatalog(env.BILLING_CATALOG_JSON).filter((offer) =>
            Boolean(offer.providers[id]),
          ).length;
          row.mode = env[`BILLING_${id.toUpperCase()}_MODE`];
        } catch {
          row.status = 'invalid';
        }
      }
      rows.push(row);
    }
    // Account/transactional mail follows MAIL_PROVIDER (smtp default, or resend), like the runtime transport.
    const mailTransport = mailTransportSettingsFromConnection(env);
    const resendMail = mailTransport?.kind === 'resend';
    const accountMail = base(
      'account-email',
      '账户邮件',
      '邮件',
      true,
      missing(resendMail ? ['SMTP_FROM', 'MAIL_RESEND_API_KEY', 'WEB_URL'] : ['SMTP_HOST', 'SMTP_FROM', 'WEB_URL']),
      connectionSdkAvailable('@zucker-framework/notification', resendMail ? 'resend' : 'nodemailer'),
    );
    if (!mailTransport) accountMail.status = 'invalid';
    else if (accountMail.status === 'configured' && resendMail) {
      try {
        oauthSettings(env);
        accountMail.mode = 'resend';
      } catch {
        accountMail.status = 'invalid';
      }
    } else if (accountMail.status === 'configured') {
      let provider: EmailProvider | undefined;
      try {
        const port = Number(env.SMTP_PORT ?? 587);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error();
        oauthSettings(env);
        provider = new EmailProvider({
          host: env.SMTP_HOST!,
          port,
          secure: env.SMTP_SECURE === 'true',
          from: env.SMTP_FROM!,
          auth: { user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' },
        });
        if (!provider.isConfigured()) throw new Error();
        accountMail.mode = 'smtp';
      } catch {
        accountMail.status = 'invalid';
      } finally {
        await provider?.close();
      }
    }
    rows.push(accountMail);
    const kind = env.DELIVERY_PROVIDER ?? 'none',
      durableEnabled = kind !== 'none';
    const deliveryKeys =
      kind === 'resend'
        ? ['DELIVERY_ACCOUNT_SCOPE', 'DELIVERY_FROM', 'DELIVERY_RESEND_API_KEY']
        : kind === 'smtp'
          ? [
              'DELIVERY_ACCOUNT_SCOPE',
              'DELIVERY_FROM',
              'DELIVERY_SMTP_HOST',
              'DELIVERY_SMTP_USER',
              'DELIVERY_SMTP_PASSWORD',
            ]
          : [];
    const deliverySdk =
      !durableEnabled ||
      connectionSdkAvailable(
        '@zucker-framework/notification',
        kind === 'resend' ? 'resend' : 'nodemailer',
      );
    const delivery = base(
      'durable-email',
      '任务通知邮件',
      '邮件',
      durableEnabled,
      durableEnabled ? missing(deliveryKeys) : [],
      deliverySdk,
    );
    if (delivery.status === 'configured') {
      let options;
      try {
        options = deliveryOptionsFromEnvironment(env);
        if (!options.provider?.isConfigured()) throw new Error();
        delivery.mode = kind;
      } catch {
        delivery.status = 'invalid';
      } finally {
        await options?.provider?.close();
      }
    }
    rows.push(delivery);
    for (const id of ['google', 'github'] as const) {
      const enabled =
        id === 'google'
          ? env.GOOGLE_OAUTH_ENABLED === 'true' || env.GOOGLE_ONE_TAP_ENABLED === 'true'
          : env.GITHUB_OAUTH_ENABLED === 'true';
      const fields =
        id === 'github'
          ? ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']
          : [
              'GOOGLE_CLIENT_ID',
              ...(env.GOOGLE_OAUTH_ENABLED === 'true' ? ['GOOGLE_CLIENT_SECRET'] : []),
            ];
      const row = base(
        `identity-${id}`,
        id === 'google' ? 'Google 登录' : 'GitHub 登录',
        '登录',
        enabled,
        enabled ? missing(fields) : [],
      );
      if (row.status === 'configured')
        try {
          const options = oauthSettings(env);
          if (
            id === 'github' ? !options.github.code : !options.google.code && !options.google.oneTap
          )
            throw new Error();
        } catch {
          row.status = 'invalid';
        }
      rows.push(row);
    }
    const storageKind = env.FILES_STORAGE_PROVIDER ?? 'local';
    const storage = base(
      'private-files',
      '私有文件存储',
      '存储',
      true,
      storageKind === 's3'
        ? missing(['FILES_S3_BUCKET', 'FILES_S3_ACCESS_KEY_ID', 'FILES_S3_SECRET_ACCESS_KEY'])
        : [],
      storageKind !== 's3' ||
        connectionSdkAvailable('@zucker-framework/storage', '@aws-sdk/client-s3'),
    );
    if (storage.status === 'configured')
      try {
        const options = storageOptionsFromEnvironment(env);
        storage.mode = options.provider;
      } catch {
        storage.status = 'invalid';
      }
    rows.push(storage);
    const providers = this.ai?.list() ?? [];
    rows.push({
      id: 'ai',
      name: 'AI ProviderManager 注册表',
      category: 'AI',
      source: 'runtime-registration',
      status: providers.length ? 'configured' : 'not-registered',
      enabled: providers.length > 0,
      missing: [],
      sdkAvailable: null,
      registeredProviderIds: providers.map((provider) => provider.id),
      configurationSourceIds: this.aiConfig?.getSources().map((source) => source.id) ?? [],
      note: '此项是独立的旧 ProviderManager 注册表，展示本进程已注册提供者和配置源；不代表 Native AI 连接或业务场景已配置。未读取模型密钥或调用模型。',
    });
    rows.push(
      ...inspectAIConnections(env).map((row) => ({
        ...row,
        source: 'runtime-snapshot' as const,
        note: '仅检查启用字段与本地原生 SDK 装配；尚未远端验证或调用模型，也不表示已配置业务场景。',
      })),
    );
    for (const kind of ['analytics', 'connections'] as const) {
      const enabled =
        env[kind === 'analytics' ? 'SITE_ANALYTICS_ENABLED' : 'SITE_CONNECTIONS_ENABLED'] ===
        'true';
      const row = base(
        `web-${kind}`,
        kind === 'analytics' ? '网站分析' : '网站广告、联盟与客服',
        '公开站点',
        enabled,
        [],
      );
      row.sdkAvailable = null;
      row.note =
        '展示 Server 已应用并通过公开配置接口提供给 Web 的设置；未确认浏览器脚本加载或第三方服务连通。保存后需重启 Server。';
      try {
        if (kind === 'analytics') validatePublicAnalytics(siteAnalyticsConfig(env));
        else validatePublicConnections(siteConnectionsConfig(env));
      } catch {
        row.status = 'invalid';
      }
      rows.push(row);
    }
    if (this.settings) {
      const { profiles } = await this.settings.list();
      const hot = hotConnectionStatus(this.settings);
      for (const row of rows) {
        const profile = profiles.find((profile) => profile.id === row.id);
        if (profile) {
          row.source = 'runtime-snapshot';
          row.applyMode = profile.applyMode;
          row.storedRevision = profile.storedRevision;
          row.appliedRevision = profile.appliedRevision;
          row.pendingRestart = profile.pendingRestart;
          if (profile.applyMode === 'hot') {
            row.note = row.id.startsWith('web-')
              ? '展示 Server 当前保存并通过公开配置接口提供给 Web 的设置；未确认浏览器脚本加载或第三方服务连通。保存后下一次请求生效。'
              : HOT_NOTE;
            // A hot profile applies to the next request (applied = stored), unless the provider for the
            // newest saved revision could not be assembled: then the older served revision is reported.
            const status = hot.get(profile.id);
            if (status?.failedRevision !== undefined && status.failedRevision >= profile.storedRevision) {
              row.applyError = { revision: status.failedRevision, reason: 'provider_assembly_failed' };
              if (status.servedRevision !== undefined) row.appliedRevision = status.servedRevision;
            }
            row.pendingRestart = false;
          }
        }
      }
    }
    return { connections: rows, checkedAt: new Date().toISOString(), externalRequests: false };
  }
}
