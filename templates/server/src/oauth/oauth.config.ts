export type OAuthProvider = 'google' | 'github';
export const OAUTH_SETTINGS = Symbol('OAUTH_SETTINGS');
export interface OAuthSettings {
  webOrigin: string;
  secureCookies: boolean;
  google: { clientId: string; clientSecret: string; code: boolean; oneTap: boolean };
  github: { clientId: string; clientSecret: string; code: boolean };
}
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
