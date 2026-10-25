import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { exchangeGitHubOAuthCode, exchangeGoogleOAuthCode, GoogleIdTokenVerifier, type VerifiedOAuthIdentity } from '@zucker-framework/auth';
import { OAUTH_SETTINGS, type OAuthProvider, type OAuthSettings } from './oauth.config';

export const OAUTH_PROVIDER_CLIENT = Symbol('OAUTH_PROVIDER_CLIENT');
export interface OAuthCodeInput { code: string; nonce: string; codeVerifier: string; redirectUri: string }
export interface OAuthProviderClient {
  code(provider: OAuthProvider, input: OAuthCodeInput): Promise<VerifiedOAuthIdentity>;
  oneTap(credential: string, nonce: string): Promise<VerifiedOAuthIdentity>;
}

@Injectable()
export class ConfiguredOAuthProviderClient implements OAuthProviderClient {
  private readonly google?: GoogleIdTokenVerifier;
  constructor(@Inject(OAUTH_SETTINGS) private readonly settings: OAuthSettings) {
    if (settings.google.clientId) this.google = new GoogleIdTokenVerifier({ audience: settings.google.clientId });
  }
  async code(provider: OAuthProvider, input: OAuthCodeInput): Promise<VerifiedOAuthIdentity> {
    try {
      if (provider === 'google') {
        const profile = await exchangeGoogleOAuthCode({ ...input, clientId: this.settings.google.clientId,
          clientSecret: this.settings.google.clientSecret, signal: AbortSignal.timeout(10_000) });
        if (!profile.idToken || !this.google) throw new Error('Missing identity token');
        const identity = await this.google.verify(profile.idToken, { nonce: input.nonce });
        if (identity.subject !== profile.id) throw new Error('Subject mismatch');
        return identity;
      }
      const profile = await exchangeGitHubOAuthCode({ ...input, clientId: this.settings.github.clientId,
        clientSecret: this.settings.github.clientSecret, includeEmailVerification: true, signal: AbortSignal.timeout(10_000) });
      return { provider, subject: profile.id, email: profile.email ?? undefined, emailVerified: profile.emailVerified === true,
        displayName: profile.displayName, avatarUrl: profile.picture };
    } catch { throw new UnauthorizedException('Provider identity could not be verified'); }
  }
  async oneTap(credential: string, nonce: string): Promise<VerifiedOAuthIdentity> {
    try {
      if (!this.google) throw new Error('Provider is disabled');
      return await this.google.verify(credential, { nonce });
    } catch { throw new UnauthorizedException('Provider identity could not be verified'); }
  }
}
