import { GITHUB_OAUTH_CONNECTION_DESCRIPTOR, GOOGLE_OAUTH_CONNECTION_DESCRIPTOR } from '@zucker-framework/auth';
import { oauthSettings } from '../../oauth/oauth.config';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../registry';

const label = (text: string) => ({ label: text });
/** Sign-in providers are hot: `OAuthModule` reads them through a `HotProvider` (pinned per OAuth request). */
export const IDENTITY_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'hot',
    validate: env => {
      const settings = oauthSettings(env);
      if (env.GOOGLE_OAUTH_ENABLED === 'true' && !settings.google.code || env.GOOGLE_ONE_TAP_ENABLED === 'true' && !settings.google.oneTap) throw new Error('google');
    },
    profile: localizeConnectionDescriptor(GOOGLE_OAUTH_CONNECTION_DESCRIPTOR, { name: 'Google 登录', category: '登录', fields: {
      GOOGLE_OAUTH_ENABLED: label('OAuth 登录'), GOOGLE_ONE_TAP_ENABLED: label('One Tap'), GOOGLE_CLIENT_ID: label('Client ID'), GOOGLE_CLIENT_SECRET: label('Client Secret') } }) }),
  defineConnectionProfile({ applyMode: 'hot',
    validate: env => { const settings = oauthSettings(env); if (env.GITHUB_OAUTH_ENABLED === 'true' && !settings.github.code) throw new Error('github'); },
    profile: localizeConnectionDescriptor(GITHUB_OAUTH_CONNECTION_DESCRIPTOR, { name: 'GitHub 登录', category: '登录', fields: {
      GITHUB_OAUTH_ENABLED: label('启用'), GITHUB_CLIENT_ID: label('Client ID'), GITHUB_CLIENT_SECRET: label('Client Secret') } }) }),
];
