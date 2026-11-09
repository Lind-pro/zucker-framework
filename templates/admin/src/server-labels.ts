/**
 * English for display text the server template sends to the back office. Entries are keyed by the
 * stable `labelKey` the server sends next to the text (connection profiles, categories and fields in
 * `/management/connection-settings`, entitlement catalog features and counters), so rewording the
 * server's Chinese text keeps the translation. Brand names and IDs that read the same in English
 * (Stripe, Client ID, Bucket …) have no entry and are shown as received.
 *
 * Keep in sync with templates/server `runtime-settings/connection-settings.descriptors.ts`,
 * `subscriptions/entitlement-catalog.ts` and `management/connections.service.ts`.
 */
const connectionLabels: Readonly<Record<string, string>> = {
  // Categories
  'connections.category.ai': 'AI',
  'connections.category.public-site': 'Public website',
  'connections.category.payments': 'Payments',
  'connections.category.sign-in': 'Sign-in',
  'connections.category.mail': 'Email',
  'connections.category.storage': 'Storage',
  // Profiles
  'connections.ai-compatible': 'OpenAI-compatible API',
  'connections.ai-gemini': 'Gemini (GenAI)',
  'connections.web-analytics': 'Site analytics',
  'connections.web-connections': 'Site ads, referrals and support',
  'connections.identity-google': 'Google sign-in',
  'connections.identity-github': 'GitHub sign-in',
  'connections.account-email': 'Account email (SMTP)',
  'connections.durable-email': 'Job notification email',
  'connections.private-files': 'Private storage (S3 / R2)',
  // Native AI profile fields (prefix-independent keys)
  'connections.field.AI_ENABLED': 'Enabled',
  'connections.field.AI_API_KEY': 'API key',
  'connections.field.AI_MODEL_ID': 'Model ID',
  'connections.field.AI_BASE_URL': 'API URL',
  'connections.field.AI_BASE_URL.description':
    'Use an HTTPS URL without credentials, query parameters or a fragment. Compatible providers require an explicit URL.',
  'connections.field.AI_MAX_TOKENS': 'Maximum output tokens',
  'connections.field.AI_MAX_TOKENS.description':
    'Required for Anthropic. Other connections may specify this per call. Respect the selected model limit.',
  'connections.field.AI_TIMEOUT_MS': 'Timeout (ms)',
  // Public website
  'connections.field.SITE_ANALYTICS_ENABLED': 'Enable site analytics',
  'connections.field.PLAUSIBLE_SCRIPT_URL': 'Plausible script URL',
  'connections.field.PLAUSIBLE_SCRIPT_URL.description': 'HTTPS or a same-origin script path. Site installation parameters are allowed.',
  'connections.field.OPENPANEL_CLIENT_ID': 'OpenPanel public Client ID',
  'connections.field.OPENPANEL_API_URL': 'OpenPanel API URL',
  'connections.field.OPENPANEL_API_URL.description': 'Optional HTTPS or same-origin URL. Do not enter a Client Secret.',
  'connections.field.VERCEL_ANALYTICS_SCRIPT_PATH': 'Vercel script path',
  'connections.field.VERCEL_ANALYTICS_SCRIPT_PATH.description': 'Enter the same-origin script path provided for this project.',
  'connections.field.SITE_CONNECTIONS_ENABLED': 'Enable site connections',
  'connections.field.ADSENSE_PUBLISHER_ID': 'AdSense public Publisher ID',
  'connections.field.AFFONSO_PROGRAM_ID': 'Affonso public Program ID',
  'connections.field.AFFONSO_COOKIE_DURATION_DAYS': 'Affonso cookie duration (days)',
  'connections.field.AFFONSO_COOKIE_DURATION_DAYS.description': 'Required when Affonso is enabled. Use a duration allowed by the service.',
  'connections.field.PROMOTEKIT_PROGRAM_ID': 'PromoteKit public Program ID',
  // Payments
  'connections.field.BILLING_STRIPE_ENABLED': 'Enabled',
  'connections.field.BILLING_STRIPE_MODE': 'Mode',
  'connections.field.BILLING_STRIPE_ACCOUNT_SCOPE': 'Account scope',
  'connections.field.STRIPE_SECRET_KEY': 'API key',
  'connections.field.STRIPE_WEBHOOK_SECRET': 'Webhook signing secret',
  'connections.field.BILLING_PAYPAL_ENABLED': 'Enabled',
  'connections.field.BILLING_PAYPAL_MODE': 'Mode',
  'connections.field.BILLING_PAYPAL_ACCOUNT_SCOPE': 'Account scope',
  'connections.field.BILLING_CREEM_ENABLED': 'Enabled',
  'connections.field.BILLING_CREEM_MODE': 'Mode',
  'connections.field.BILLING_CREEM_ACCOUNT_SCOPE': 'Account scope',
  'connections.field.CREEM_API_KEY': 'API key',
  'connections.field.CREEM_WEBHOOK_SECRET': 'Webhook signing secret',
  // Sign-in
  'connections.field.GOOGLE_OAUTH_ENABLED': 'OAuth sign-in',
  'connections.field.GITHUB_OAUTH_ENABLED': 'Enabled',
  // Email
  'connections.field.SMTP_HOST': 'SMTP host',
  'connections.field.SMTP_PORT': 'Port',
  'connections.field.SMTP_SECURE': 'Use TLS',
  'connections.field.SMTP_FROM': 'Sender',
  'connections.field.SMTP_USER': 'SMTP username',
  'connections.field.SMTP_PASSWORD': 'SMTP password',
  'connections.field.DELIVERY_PROVIDER': 'Provider',
  'connections.field.DELIVERY_ACCOUNT_SCOPE': 'Account scope',
  'connections.field.DELIVERY_FROM': 'Sender',
  'connections.field.DELIVERY_RESEND_API_KEY': 'Resend API key',
  'connections.field.DELIVERY_SMTP_HOST': 'SMTP host',
  'connections.field.DELIVERY_SMTP_PORT': 'Port',
  'connections.field.DELIVERY_SMTP_SECURE': 'Use TLS',
  'connections.field.DELIVERY_SMTP_USER': 'SMTP username',
  'connections.field.DELIVERY_SMTP_PASSWORD': 'SMTP password',
  // Storage
  'connections.field.FILES_STORAGE_PROVIDER': 'Storage type',
  'connections.field.FILES_S3_ENDPOINT': 'S3-compatible endpoint',
  'connections.field.FILES_S3_FORCE_PATH_STYLE': 'Use path style (leave unset for endpoint default)',
};

/**
 * The template catalog is already in English; keyed entries let a product reword the server text
 * (or serve another language) without losing this table.
 */
const entitlementLabels: Readonly<Record<string, string>> = {
  'entitlements.feature.projects': 'Projects',
  'entitlements.feature.projects.description': 'Create a project; work inside a counted project is free',
  'entitlements.feature.exports': 'Exports',
  'entitlements.feature.exports.description': 'Export a finished result',
  'entitlements.feature.prioritySupport': 'Priority support',
  'entitlements.feature.prioritySupport.description': 'Faster support responses',
  'entitlements.feature.adFree': 'Ad-free',
  'entitlements.feature.adFree.description': 'No advertising while the subscription is active',
  'entitlements.counter.projects_per_month': 'Projects',
  'entitlements.counter.projects_per_month.unit': 'per month',
  'entitlements.counter.exports_per_day': 'Exports',
  'entitlements.counter.exports_per_day.unit': 'per day',
};

/** Server text without a stable key (connection status rows and notes from ConnectionsService). */
const textLabels: Readonly<Record<string, string>> = {
  // Status rows of `/management/connections` carry no category key of their own.
  '公开站点': 'Public website',
  '支付': 'Payments',
  '登录': 'Sign-in',
  '邮件': 'Email',
  '存储': 'Storage',
  '私有文件存储': 'Private file storage',
  'AI ProviderManager 注册表': 'AI ProviderManager registry',
  '仅校验本地配置与依赖；未连接外部服务。环境配置修改后需重启服务。':
    'Only local configuration and dependencies are checked. No external service is contacted. Restart after changing environment configuration.',
  '此项是独立的旧 ProviderManager 注册表，展示本进程已注册提供者和配置源；不代表 Native AI 连接或业务场景已配置。未读取模型密钥或调用模型。':
    'This is the separate legacy ProviderManager registry for providers and configuration sources. It does not represent Native AI connections or business scenarios. No model keys are read and no model is called.',
  '仅检查启用字段与本地原生 SDK 装配；尚未远端验证或调用模型，也不表示已配置业务场景。':
    'Only enabled fields and local native SDK assembly are checked. No remote verification or model call is made, and business scenarios are not implied.',
  '展示 Server 已应用并通过公开配置接口提供给 Web 的设置；未确认浏览器脚本加载或第三方服务连通。保存后需重启 Server。':
    'Shows settings applied by Server and served to Web through public configuration. Browser script loading and third-party connectivity are not verified. Restart Server after saving.',
};

export const serverLabelsEnUS: Readonly<Record<string, string>> = { ...connectionLabels, ...entitlementLabels, ...textLabels };
