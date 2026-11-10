import type { OneTimeTicketRecord, OAuthProofRecord } from '@zucker-framework/auth';
import type { OAuthProvider } from './oauth.config';

export interface OAuthIntent extends OneTimeTicketRecord {
  provider: OAuthProvider;
  purpose: 'login' | 'link';
  mode: 'code' | 'onetap';
  nonce: string;
  codeVerifier: string | null;
  browserBindingHash: string;
  origin: string;
  locale: 'en' | 'zh';
  returnPath: string;
  userId: string | null;
  sessionId: string | null;
}
export interface OAuthHandoff extends OAuthProofRecord {
  origin: string;
  locale: 'en' | 'zh';
  returnPath: string;
}
export interface OAuthRequestContext {
  browserBinding: string;
  origin?: string;
  user?: { id: string; sid: string };
  sessionCookie?: string;
  /** Client IP as Express derived it (TRUST_PROXY); recorded once as sign-up acquisition data. */
  ip?: string;
}
export interface BindingRecord { id: string; userId: string; provider: OAuthProvider; providerAccountId: string }
