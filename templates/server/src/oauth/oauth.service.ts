import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter, type ModelOperations } from '@zucker-framework/core';
import { DatabaseOneTimeTicketStore, OneTimeTicketService, OneTimeTicketError, OAuthProofService, OAuthProofError, PostgresIdentityTransactions, ThirdPartyAccountService, UserService,
  type OAuthProofContext, type OAuthProofRecord, type VerifiedOAuthIdentity, type UserEntity } from '@zucker-framework/auth';
import { AccountService } from '../accounts/account.service';
import { AccountOnboarding, type SignupWelcome } from '../accounts/account-onboarding';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { OAUTH_SETTINGS, type OAuthProvider, type OAuthSettings } from './oauth.config';
import { OAUTH_PROVIDER_CLIENT, type OAuthProviderClient } from './oauth-provider';
import type { BindingRecord, OAuthHandoff, OAuthIntent, OAuthRequestContext } from './oauth.types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
function record(body: unknown, allowed: readonly string[]): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.entries(body).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string' || value.length > 16_384)) {
    throw new BadRequestException('Invalid OAuth request');
  }
  return body as Record<string, string>;
}
function returnPath(value: string | undefined, purpose: 'login' | 'link'): string {
  if (purpose === 'link') return '/account';
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '/dashboard';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded)) return '/dashboard';
    const url = new URL(value, 'https://account.invalid');
    const path = url.pathname.replace(/^\/(?:en|zh)(?=\/|$)/, '') || '/';
    const managed = ['/content/manage', '/billing/subscriptions'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
      && !/%(?:2f|5c|2e|25)/i.test(path);
    return managed || ['/account', '/dashboard', '/billing/orders', '/billing/return', '/pricing'].includes(path) ? path + url.search : '/dashboard';
  } catch { return '/dashboard'; }
}

@Injectable()
export class OAuthService {
  constructor(@Inject(DATABASE_ADAPTER) private readonly db: ApplicationDatabase,
    @Inject(OAUTH_SETTINGS) readonly settings: OAuthSettings,
    @Inject(OAUTH_PROVIDER_CLIENT) private readonly providerClient: OAuthProviderClient,
    private readonly accounts: AccountService,
    @Optional() private readonly onboarding?: AccountOnboarding) {}

  providers() {
    const result: Array<{ id: OAuthProvider; code: boolean; oneTapClientId?: string }> = [];
    if (this.settings.google.code || this.settings.google.oneTap) result.push({ id: 'google', code: this.settings.google.code,
      ...(this.settings.google.oneTap ? { oneTapClientId: this.settings.google.clientId } : {}) });
    if (this.settings.github.code) result.push({ id: 'github', code: true });
    return { providers: result };
  }
  private provider(value: string, mode: 'code' | 'onetap'): OAuthProvider {
    if (value === 'google' && (mode === 'code' ? this.settings.google.code : this.settings.google.oneTap)) return value;
    if (value === 'github' && mode === 'code' && this.settings.github.code) return value;
    throw new NotFoundException('OAuth provider is unavailable');
  }
  assertOrigin(context: OAuthRequestContext): void {
    if (context.origin !== this.settings.webOrigin) throw new ForbiddenException('Untrusted OAuth request origin');
  }
  private intents() {
    return new OneTimeTicketService(new DatabaseOneTimeTicketStore(this.db.model('accountOAuthIntents') as ModelOperations<OAuthIntent>), {
      expirySeconds: 600, consumedRetentionSeconds: 86400,
    });
  }
  private proofs(db: DatabaseAdapter, metadata?: Pick<OAuthIntent, 'origin' | 'locale' | 'returnPath'>, verified?: VerifiedOAuthIdentity) {
    const base = new DatabaseOneTimeTicketStore(db.model('accountOAuthProofs') as ModelOperations<OAuthHandoff>);
    const tickets = new OneTimeTicketService<OAuthProofRecord>({
      create: data => base.create({ ...data, ...(metadata ? { origin: metadata.origin, locale: metadata.locale, returnPath: metadata.returnPath } : {}) }), find: tokenHash => base.find(tokenHash),
      claim: (id, now) => base.claim(id, now), cleanup: (now, before) => base.cleanup(now, before),
    }, { expirySeconds: 120, consumedRetentionSeconds: 86400 });
    return new OAuthProofService<undefined>({ tickets, verifyIdentity: async () => {
      if (!verified) throw new UnauthorizedException('Verified provider identity is required');
      return verified;
    } });
  }
  private proofContext(intent: OAuthIntent, browserBinding: string): OAuthProofContext {
    return intent.purpose === 'link'
      ? { purpose: 'link', provider: intent.provider, browserBinding, userId: intent.userId!, sessionId: intent.sessionId! }
      : { purpose: 'login', provider: intent.provider, browserBinding };
  }
  callbackUri(provider: OAuthProvider): string { return `${this.settings.webOrigin}/api/authorize/oauth/${provider}/callback`; }

  async start(rawProvider: string, purpose: 'login' | 'link', body: unknown, context: OAuthRequestContext) {
    this.assertOrigin(context);
    const input = record(body, ['locale', 'mode', 'returnPath']);
    const mode = input.mode === 'onetap' ? 'onetap' : input.mode === 'code' || !input.mode ? 'code' : null;
    if (!mode || !/^[A-Za-z0-9_-]{43}$/.test(context.browserBinding)) throw new BadRequestException('Invalid OAuth flow');
    const provider = this.provider(rawProvider, mode);
    if (purpose === 'link') {
      if (!context.user) throw new UnauthorizedException();
      await this.accounts.currentUser(context.user.id, context.user.sid);
    }
    const nonce = random(), codeVerifier = mode === 'code' ? random() : null;
    const intent = await this.intents().issue({ provider, purpose, mode, nonce, codeVerifier,
      browserBindingHash: hash(context.browserBinding), origin: context.origin!, locale: input.locale === 'zh' ? 'zh' : 'en',
      returnPath: returnPath(input.returnPath, purpose), userId: purpose === 'link' ? context.user!.id : null,
      sessionId: purpose === 'link' ? context.user!.sid : null });
    if (mode === 'onetap') return { intent, nonce, clientId: this.settings.google.clientId };
    const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.settings[provider].clientId, redirect_uri: this.callbackUri(provider), state: intent,
      code_challenge: createHash('sha256').update(codeVerifier!).digest('base64url'), code_challenge_method: 'S256',
      ...(provider === 'google' ? { response_type: 'code', scope: 'openid email profile', nonce, prompt: 'select_account' }
        : { scope: 'read:user user:email' }),
    }).toString();
    return { authorizationUrl: url.href };
  }

  private async consumeIntent(provider: OAuthProvider, mode: 'code' | 'onetap', state: string, context: OAuthRequestContext): Promise<OAuthIntent> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(context.browserBinding)) throw new BadRequestException('Invalid OAuth state');
    const snapshot = await this.db.model('accountOAuthIntents').findUnique({ where: { tokenHash: hash(state) } }) as OAuthIntent | null;
    if (!snapshot) throw new BadRequestException('Invalid OAuth state');
    let current = context.user;
    if (snapshot.purpose === 'link' && !current) current = await this.accounts.browserSession(context.sessionCookie ?? '');
    return this.intents().consume(state, intent => {
      if (intent.provider !== provider || intent.mode !== mode || !['login', 'link'].includes(intent.purpose) ||
        intent.origin !== this.settings.webOrigin || (context.origin !== undefined && context.origin !== intent.origin) ||
        intent.browserBindingHash !== hash(context.browserBinding) ||
        (intent.purpose === 'link' && (!current || current.id !== intent.userId || current.sid !== intent.sessionId))) {
        throw new BadRequestException('Invalid OAuth context');
      }
    }).catch(() => { throw new BadRequestException('Invalid or expired OAuth state'); });
  }

  async callback(rawProvider: string, query: unknown, context: OAuthRequestContext): Promise<string> {
    let locale = 'en';
    try {
      const provider = this.provider(rawProvider, 'code');
      if (!query || typeof query !== 'object') throw new BadRequestException('Invalid OAuth callback');
      const input = query as Record<string, unknown>;
      if (typeof input.state !== 'string') throw new BadRequestException('Invalid OAuth callback');
      const intent = await this.consumeIntent(provider, 'code', input.state, context);
      locale = intent.locale;
      if (input.error || typeof input.code !== 'string' || !input.code || input.code.length > 4096 || !intent.codeVerifier) throw new UnauthorizedException('Provider authorization failed');
      const identity = await this.providerClient.code(provider, { code: input.code, nonce: intent.nonce,
        codeVerifier: intent.codeVerifier, redirectUri: this.callbackUri(provider) });
      const proof = await this.proofs(this.db, intent, identity).issue(undefined, this.proofContext(intent, context.browserBinding));
      return `${this.settings.webOrigin}/${intent.locale}/oauth/callback?provider=${provider}&purpose=${intent.purpose}#ticket=${proof}`;
    } catch {
      // Never reflect provider errors, state, code or credentials into a page, response body or log.
      return `${this.settings.webOrigin}/${locale}/oauth/callback?error=oauth_failed`;
    }
  }

  async oneTap(body: unknown, context: OAuthRequestContext) {
    this.assertOrigin(context); const provider = this.provider('google', 'onetap');
    const input = record(body, ['intent', 'credential']);
    if (!input.intent || !input.credential) throw new BadRequestException('Invalid One Tap response');
    const intent = await this.consumeIntent(provider, 'onetap', input.intent, context);
    try {
      const identity = await this.providerClient.oneTap(input.credential, intent.nonce);
      const proof = await this.proofs(this.db, intent, identity).issue(undefined, this.proofContext(intent, context.browserBinding));
      return { proof, provider, purpose: intent.purpose };
    } catch { throw new UnauthorizedException('Provider identity could not be verified'); }
  }

  private async lock(tx: ApplicationTransaction, provider: string, subject: string, userId?: string) {
    const locks = new PostgresIdentityTransactions<ApplicationTransaction>({ namespace: 'oauth',
      transaction: work => work(tx), query: (current, sql, values) => current.query(sql, values) });
    await locks.run(`provider:${provider}:${subject}`, async () => {
      if (userId) await locks.run(`user:${userId}`, async current => {
        await current.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      });
    });
  }
  private async freshSession(tx: ApplicationTransaction, user: { id: string; sid: string }) {
    await tx.query('SELECT id FROM account_sessions WHERE id = $1 AND "userId" = $2 FOR UPDATE', [user.sid, user.id]);
    return this.accounts.currentUser(user.id, user.sid, tx);
  }
  private async handoff(tx: ApplicationTransaction, provider: string, proof: string, purpose: 'login' | 'link', context: OAuthRequestContext) {
    const row = await tx.model('accountOAuthProofs').findUnique({ where: { tokenHash: hash(proof) } }) as OAuthHandoff | null;
    if (!row || row.origin !== context.origin || row.origin !== this.settings.webOrigin || row.provider !== provider ||
      row.purpose !== `oauth_${purpose}`) throw new BadRequestException('Invalid OAuth proof');
    await this.lock(tx, provider, row.providerAccountId, purpose === 'link' ? context.user?.id : undefined);
    if (purpose === 'link') {
      if (!context.user) throw new UnauthorizedException();
      await this.freshSession(tx, context.user);
    }
    const expected: OAuthProofContext = purpose === 'link'
      ? { purpose, provider, browserBinding: context.browserBinding, userId: context.user!.id, sessionId: context.user!.sid }
      : { purpose, provider, browserBinding: context.browserBinding };
    const identity = await this.proofs(tx).consume(proof, expected);
    return { identity, row };
  }

  async complete(rawProvider: string, purpose: 'login' | 'link', body: unknown, context: OAuthRequestContext) {
    this.assertOrigin(context);
    if (!this.providers().providers.some(provider => provider.id === rawProvider)) throw new NotFoundException('OAuth provider is unavailable');
    const provider = rawProvider as OAuthProvider, input = record(body, ['proof']);
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.proof || '') || !context.browserBinding) throw new BadRequestException('Invalid OAuth proof');
    // Read once before the transaction; a closed registration rejects only first-time sign-up below.
    const policy = purpose === 'login' ? await this.accounts.policy() : null;
    let outcome: { userId: string; bindingId: string; returnPath: string; created: { user: UserEntity; welcome: SignupWelcome | null } | null };
    try {
      outcome = await this.db.transaction(async tx => {
        const { identity, row } = await this.handoff(tx, provider, input.proof, purpose, context);
        const bindings = new ThirdPartyAccountService(tx);
        const existing = await bindings.findAccount(provider, identity.subject);
        let user: UserEntity, created: { user: UserEntity; welcome: SignupWelcome | null } | null = null;
        if (purpose === 'link') {
          user = await this.accounts.currentUser(context.user!.id, context.user!.sid, tx);
          if (existing && existing.userId !== user.id) throw new ConflictException('Provider account is already linked');
          const other = await tx.model('thirdPartyBinds').findMany({ where: { userId: user.id, provider }, take: 1 }) as BindingRecord[];
          if (other[0] && other[0].providerAccountId !== identity.subject) throw new ConflictException('A different provider account is already linked');
        } else if (existing) {
          await this.lock(tx, provider, identity.subject, existing.userId);
          const found = await new UserService(tx).findById(existing.userId);
          if (!found?.status) throw new UnauthorizedException('Account is unavailable');
          user = found;
        } else {
          if (!policy?.registrationOpen) throw new ForbiddenException('Registration is closed');
          const email = identity.email?.trim().toLowerCase();
          if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new UnauthorizedException('Provider email is invalid');
          if (email && await tx.model('users').findUnique({ where: { email } })) {
            throw new ConflictException('Sign in to your existing account before linking this provider');
          }
          // Provider subjects authenticate passwordless accounts; a random username is not a generated password.
          user = await tx.model('users').create({ data: { username: `member_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
            name: identity.displayName?.trim().slice(0, 100) || `${provider === 'google' ? 'Google' : 'GitHub'} member`,
            typeId: 'member', status: true, email: identity.emailVerified ? email ?? null : null,
            emailVerified: Boolean(identity.emailVerified && email), locale: row.locale, password: null } }) as UserEntity;
          created = { user, welcome: this.onboarding ? await this.onboarding.recordSignup(tx, user.id, { method: `oauth:${provider}`, ip: context.ip }, policy) : null };
        }
        await bindings.bindAccount(user.id, provider, { providerAccountId: identity.subject, email: identity.email,
          displayName: identity.displayName, avatarUrl: identity.avatarUrl, profileData: { emailVerified: identity.emailVerified } });
        const binding = await bindings.findAccount(provider, identity.subject);
        if (!binding) throw new Error('Binding was not persisted');
        return { userId: user.id, bindingId: binding.id, returnPath: row.returnPath, created };
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('Sign in to your existing account before linking this provider');
      }
      if (error instanceof BadRequestException || error instanceof UnauthorizedException || error instanceof ConflictException
        || error instanceof ForbiddenException) throw error;
      if (error instanceof OneTimeTicketError || error instanceof OAuthProofError) throw new BadRequestException('Invalid or expired OAuth proof');
      throw new ServiceUnavailableException('OAuth confirmation could not be completed');
    }
    // After commit: welcome credits (idempotent, never fails the sign-in) and a background welcome mail.
    if (outcome.created) await this.accounts.completeProviderSignup(outcome.created.user, outcome.created.welcome);
    if (purpose === 'link') return { success: true as const, returnPath: '/account' };
    return { ...await this.accounts.providerLogin(outcome.userId, outcome.bindingId), returnPath: outcome.returnPath };
  }

  async connections(userId: string) {
    return { connections: await new ThirdPartyAccountService(this.db).getUserBinds(userId) };
  }
  async unlink(provider: string, context: OAuthRequestContext) {
    this.assertOrigin(context); if (!context.user) throw new UnauthorizedException();
    const user = context.user;
    const signedOut = await this.db.transaction(async tx => {
      const rows = await tx.model('thirdPartyBinds').findMany({ where: { userId: user.id, provider }, take: 1 }) as BindingRecord[];
      const binding = rows[0]; if (!binding) throw new NotFoundException('Provider connection was not found');
      await this.lock(tx, provider, binding.providerAccountId, user.id);
      const account = await this.freshSession(tx, user);
      const all = await tx.model('thirdPartyBinds').findMany({ where: { userId: user.id } });
      if ((!account.password || !account.emailVerified) && all.length <= 1) throw new ConflictException('Add another sign-in method before disconnecting this provider');
      await tx.model('accountSessions').updateMany({ where: { userId: user.id, oauthBindingId: binding.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'provider-unlinked' } });
      const session = await tx.model('accountSessions').findUnique({ where: { id: user.sid } }) as { oauthBindingId: string | null } | null;
      await tx.model('thirdPartyBinds').delete({ where: { id: binding.id } });
      return session?.oauthBindingId === binding.id;
    });
    return { success: true, signedOut };
  }
}
