export const CONTENT_OPTIONS = Symbol('CONTENT_OPTIONS');
export interface ContentOptions { siteUrl: string; origins: readonly string[] }
export function contentOptionsFromEnvironment(env: NodeJS.ProcessEnv): ContentOptions {
  const url = new URL(env.WEB_URL ?? 'http://localhost:4202');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('WEB_URL must be the site origin for content URLs');
  return { siteUrl: url.origin, origins: (env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()).filter(Boolean) };
}
