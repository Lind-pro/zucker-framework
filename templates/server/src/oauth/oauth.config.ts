import type { HotProvider } from '@zucker-framework/back-office/settings';
import type { OAuthProviderClient, OAuthSettings } from '@zucker-framework/back-office/accounts';

export { ACCOUNTS_OAUTH_SETTINGS as OAUTH_SETTINGS, type OAuthProvider, type OAuthSettings } from '@zucker-framework/back-office/accounts';
/** Hot provider of the parsed sign-in profiles and the provider client built from them. */
export const OAUTH_CONNECTION = Symbol('OAUTH_CONNECTION');
/** Connection profiles the sign-in providers read (both hot). */
export const OAUTH_CONNECTION_PROFILES: readonly string[] = ['identity-google', 'identity-github'];
export type OAuthConnection = HotProvider<{ readonly settings: OAuthSettings; readonly client: OAuthProviderClient }>;
export function oauthSettings(env: NodeJS.ProcessEnv = process.env): OAuthSettings {
  const web = new URL(env.WEB_URL || 'http://localhost:4202');
  if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password || web.search || web.hash || web.pathname !== '/') {
    throw new Error('WEB_URL must be the application origin');
  }
  const googleId = env.GOOGLE_CLIENT_ID || '', googleSecret = env.GOOGLE_CLIENT_SECRET || '';
  const githubId = env.GITHUB_CLIENT_ID || '', githubSecret = env.GITHUB_CLIENT_SECRET || '';
  return { webOrigin: web.origin, secureCookies: env.NODE_ENV === 'production',
    google: { clientId: googleId, clientSecret: googleSecret,
      code: env.GOOGLE_OAUTH_ENABLED === 'true' && Boolean(googleId && googleSecret),
      oneTap: env.GOOGLE_ONE_TAP_ENABLED === 'true' && Boolean(googleId) },
    github: { clientId: githubId, clientSecret: githubSecret, code: env.GITHUB_OAUTH_ENABLED === 'true' && Boolean(githubId && githubSecret) },
  };
}
