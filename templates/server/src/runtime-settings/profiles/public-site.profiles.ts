import { connectionField, defineConnectionProfile } from '../registry';
import { siteAnalyticsConfig, siteConnectionsConfig, validatePublicAnalytics, validatePublicConnections } from '../site-public.config';

const { boolean, text } = connectionField;
/**
 * Public website profiles are `hot`: their only consumer is `ConnectionSettingsService.publicIntegrations()`,
 * which reads them through `liveEnvironment()`. They hold public identifiers only (no secret fields).
 */
export const PUBLIC_SITE_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'hot', validate: env => validatePublicAnalytics(siteAnalyticsConfig(env)),
    profile: { id: 'web-analytics', name: '网站分析', category: '公开站点', fields: [boolean('SITE_ANALYTICS_ENABLED', '启用网站分析'),
      boolean('GOOGLE_ANALYTICS_ENABLED', 'Google Analytics'), text('GOOGLE_ANALYTICS_MEASUREMENT_ID', 'GA4 Measurement ID'),
      boolean('CLARITY_ENABLED', 'Microsoft Clarity'), text('CLARITY_PROJECT_ID', 'Clarity Project ID'),
      boolean('PLAUSIBLE_ENABLED', 'Plausible'), { ...text('PLAUSIBLE_SCRIPT_URL', 'Plausible 安装脚本地址'), description: 'HTTPS 或同源脚本路径，可包含站点安装参数。' },
      boolean('OPENPANEL_ENABLED', 'OpenPanel'), text('OPENPANEL_CLIENT_ID', 'OpenPanel 公开 Client ID'),
      { ...text('OPENPANEL_API_URL', 'OpenPanel API 地址'), description: '可选 HTTPS 或同源地址；不得填写 Client Secret。' },
      boolean('VERCEL_ANALYTICS_ENABLED', 'Vercel Analytics'), { ...text('VERCEL_ANALYTICS_SCRIPT_PATH', 'Vercel 安装脚本路径'), description: '填写该项目提供的同源脚本路径。' }] } }),
  defineConnectionProfile({ applyMode: 'hot', validate: env => validatePublicConnections(siteConnectionsConfig(env)),
    profile: { id: 'web-connections', name: '网站广告、联盟与客服', category: '公开站点', fields: [boolean('SITE_CONNECTIONS_ENABLED', '启用网站连接'),
      boolean('ADSENSE_ENABLED', 'Google AdSense'), text('ADSENSE_PUBLISHER_ID', 'AdSense 公开 Publisher ID'),
      boolean('AFFONSO_ENABLED', 'Affonso'), text('AFFONSO_PROGRAM_ID', 'Affonso 公开 Program ID'),
      { key: 'AFFONSO_COOKIE_DURATION_DAYS', label: 'Affonso Cookie 天数', type: 'number', description: '启用 Affonso 时必填；以该服务允许的时长为准。' },
      boolean('PROMOTEKIT_ENABLED', 'PromoteKit'), text('PROMOTEKIT_PROGRAM_ID', 'PromoteKit 公开 Program ID'),
      boolean('CRISP_ENABLED', 'Crisp'), text('CRISP_WEBSITE_ID', 'Crisp Website ID'),
      boolean('TAWK_ENABLED', 'tawk.to'), text('TAWK_PROPERTY_ID', 'tawk.to Property ID'), text('TAWK_WIDGET_ID', 'tawk.to Widget ID')] } }),
];
