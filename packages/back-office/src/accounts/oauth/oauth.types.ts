import type { OAuthProofRecord, OneTimeTicketRecord, VerifiedOAuthIdentity } from '@zucker-framework/auth';

export type OAuthProvider = 'google' | 'github';
/** Provider settings as read per request (compose a live view to hot-apply changes). */
export interface OAuthSettings {
  /** Web application origin: trusted Origin of OAuth mutations and base of callback/completion URLs. */
  webOrigin: string;
  secureCookies: boolean;
  google: { clientId: string; clientSecret: string; code: boolean; oneTap: boolean };
  github: { clientId: string; clientSecret: string; code: boolean };
}
export interface OAuthCodeInput { code: string; nonce: string; codeVerifier: string; redirectUri: string }
/** Verifies provider identities (authorization-code exchange and Google One Tap ID tokens). */
export interface OAuthProviderClient {
  code(provider: OAuthProvider, input: OAuthCodeInput): Promise<VerifiedOAuthIdentity>;
  oneTap(credential: string, nonce: string): Promise<VerifiedOAuthIdentity>;
}
export interface OAuthIntent extends OneTimeTicketRecord {
  provider: OAuthProvider;
  purpose: 'login' | 'link';
  mode: 'code' | 'onetap';
  nonce: string;
  codeVerifier: string | null;
  browserBindingHash: string;
  origin: string;
  locale: string;
  returnPath: string;
  userId: string | null;
  sessionId: string | null;
}
export interface OAuthHandoff extends OAuthProofRecord {
  origin: string;
  locale: string;
  returnPath: string;
}
export interface OAuthRequestContext {
  browserBinding: string;
  origin?: string;
  user?: { id: string; sid: string };
  sessionCookie?: string;
  /** Client IP as Express derived it (trusted proxy); recorded once as sign-up acquisition data. */
  ip?: string;
}
export interface BindingRecord { id: string; userId: string; provider: OAuthProvider; providerAccountId: string }
