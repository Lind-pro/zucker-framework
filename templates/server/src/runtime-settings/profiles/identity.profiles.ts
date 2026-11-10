import { oauthSettings } from '../../oauth/oauth.config';
import { connectionField, defineConnectionProfile } from '../registry';

const { boolean, secret, text } = connectionField;
export const IDENTITY_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'restart',
    validate: env => {
      const settings = oauthSettings(env);
      if (env.GOOGLE_OAUTH_ENABLED === 'true' && !settings.google.code || env.GOOGLE_ONE_TAP_ENABLED === 'true' && !settings.google.oneTap) throw new Error('google');
    },
    profile: { id: 'identity-google', name: 'Google 登录', category: '登录', fields: [boolean('GOOGLE_OAUTH_ENABLED', 'OAuth 登录'), boolean('GOOGLE_ONE_TAP_ENABLED', 'One Tap'),
      text('GOOGLE_CLIENT_ID', 'Client ID'), secret('GOOGLE_CLIENT_SECRET', 'Client Secret')] } }),
  defineConnectionProfile({ applyMode: 'restart',
    validate: env => { const settings = oauthSettings(env); if (env.GITHUB_OAUTH_ENABLED === 'true' && !settings.github.code) throw new Error('github'); },
    profile: { id: 'identity-github', name: 'GitHub 登录', category: '登录', fields: [boolean('GITHUB_OAUTH_ENABLED', '启用'), text('GITHUB_CLIENT_ID', 'Client ID'), secret('GITHUB_CLIENT_SECRET', 'Client Secret')] } }),
];
