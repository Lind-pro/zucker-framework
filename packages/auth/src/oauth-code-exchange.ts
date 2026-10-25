export type OAuthCodeExchangeProvider = 'google' | 'github';
export type OAuthCodeExchangeStage = 'token' | 'profile' | 'emails';

export class OAuthCodeExchangeError extends Error {
  constructor(
    readonly provider: OAuthCodeExchangeProvider,
    readonly stage: OAuthCodeExchangeStage,
    readonly status?: number,
  ) {
    super(`${provider} OAuth ${stage} request failed`);
    this.name = 'OAuthCodeExchangeError';
  }
}

export interface OAuthCodeExchangeOptions {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  codeVerifier?: string;
  /** Fetch authoritative GitHub email evidence even when public email is present. */
  includeEmailVerification?: boolean;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Localized presentation belongs to the consumer; failures contain no tokens/body. */
  errorFactory?: (failure: OAuthCodeExchangeError) => Error;
}

export interface GoogleOAuthCodeExchangeOptions extends OAuthCodeExchangeOptions {
  redirectUri: string;
}

export interface GoogleOAuthCodeProfile {
  idToken?: string;
  emailVerified?: boolean;
  provider: 'google';
  id: string;
  email: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  picture?: string;
  accessToken: string;
  refreshToken?: string;
}

export interface GitHubOAuthCodeProfile {
  emailVerified?: boolean;
  provider: 'github';
  id: string;
  email: string | null;
  displayName: string;
  username: string;
  picture?: string;
  profileUrl?: string;
  accessToken: string;
  refreshToken?: string;
}

function failure(
  options: OAuthCodeExchangeOptions,
  provider: OAuthCodeExchangeProvider,
  stage: OAuthCodeExchangeStage,
  status?: number,
): Error {
  const error = new OAuthCodeExchangeError(provider, stage, status);
  return options.errorFactory?.(error) ?? error;
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: OAuthCodeExchangeOptions,
  provider: OAuthCodeExchangeProvider,
  stage: OAuthCodeExchangeStage,
): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, { ...init, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw failure(options, provider, stage);
  }
  if (!response.ok) throw failure(options, provider, stage, response.status);
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw failure(options, provider, stage, response.status);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Exchange a Google authorization code and project userinfo into a typed profile. */
export async function exchangeGoogleOAuthCode(
  options: GoogleOAuthCodeExchangeOptions,
): Promise<GoogleOAuthCodeProfile> {
  const tokenData = record(
    await requestJson(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: options.code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: options.redirectUri,
          grant_type: 'authorization_code',
          ...(options.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
        }),
      },
      options,
      'google',
      'token',
    ),
  );
  const accessToken = text(tokenData?.access_token);
  if (!accessToken) throw failure(options, 'google', 'token');
  const user = record(
    await requestJson(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      options,
      'google',
      'profile',
    ),
  );
  const id = text(user?.id);
  const email = text(user?.email);
  if (!user || !id || !email) throw failure(options, 'google', 'profile');
  return {
    provider: 'google',
    ...(text(tokenData?.id_token) ? { idToken: text(tokenData?.id_token) } : {}),
    ...(typeof user.verified_email === 'boolean' ? { emailVerified: user.verified_email } : {}),
    id,
    email,
    displayName: text(user.name) ?? '',
    firstName: text(user.given_name),
    lastName: text(user.family_name),
    picture: text(user.picture),
    accessToken,
    refreshToken: text(tokenData?.refresh_token),
  };
}

/**
 * Exchange a GitHub code, query the account, and query primary email only when
 * public email is absent. Email verification/account linking remain consumer policy.
 */
export async function exchangeGitHubOAuthCode(
  options: OAuthCodeExchangeOptions,
): Promise<GitHubOAuthCodeProfile> {
  const tokenData = record(
    await requestJson(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: options.code,
          ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
          ...(options.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
        }),
      },
      options,
      'github',
      'token',
    ),
  );
  const accessToken = text(tokenData?.access_token);
  if (!accessToken) throw failure(options, 'github', 'token');
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github.v3+json',
  };
  const user = record(
    await requestJson('https://api.github.com/user', { headers }, options, 'github', 'profile'),
  );
  const id =
    typeof user?.id === 'number' && Number.isSafeInteger(user.id)
      ? String(user.id)
      : text(user?.id);
  const username = text(user?.login);
  if (!user || !id || !username) throw failure(options, 'github', 'profile');
  let email = text(user.email) || null;
  let emailVerified: boolean | undefined;
  if (!email || options.includeEmailVerification) {
    const emails = await requestJson(
      'https://api.github.com/user/emails',
      { headers },
      options,
      'github',
      'emails',
    );
    if (!Array.isArray(emails)) throw failure(options, 'github', 'emails');
    const entries = emails.map(record);
    const primary = entries.find((entry) => entry?.primary === true);
    if (options.includeEmailVerification) {
      const verified = entries.find(entry => entry?.primary === true && entry.verified === true) ?? entries.find(entry => entry?.verified === true);
      email = text(verified?.email) || text(primary?.email) || email;
      emailVerified = Boolean(email && entries.some(entry => entry?.email === email && entry.verified === true));
    } else email = text(primary?.email) || null;
  }
  return {
    provider: 'github',
    ...(emailVerified !== undefined ? { emailVerified } : {}),
    id,
    email,
    displayName: text(user.name) || username,
    username,
    picture: text(user.avatar_url),
    profileUrl: text(user.html_url),
    accessToken,
    refreshToken: text(tokenData?.refresh_token),
  };
}
