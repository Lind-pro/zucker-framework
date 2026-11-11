import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter, type ModelOperations } from '@zucker-framework/core';
import {
  DatabaseOneTimeTicketStore, OneTimeTicketService, OneTimeTicketError,
  PersistentSessionService, PersistentSessionRefreshTokenStore, RefreshTokenService, RefreshTokenError,
  BcryptEncoder, UserService, type UserEntity, type OneTimeTicketRecord, type RefreshTokenPair, type PersistentSession,
} from '@zucker-framework/auth';
import { AccountOnboarding, type SignupContext, type SignupWelcome } from './account-onboarding';
import { readAccountPolicy, type AccountPolicyValues } from './account.policy';
import { ACCOUNT_SECURITY_CLOCK, RECENT_SESSION_MS, systemAccountSecurityClock, type AccountSecurityClock } from './security/account-security.clock';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError } from './security/account-security.errors';
import { AccountTwoFactorService, secondFactor } from './security/two-factor.service';

export const ACCOUNT_MAILER = Symbol('ACCOUNT_MAILER');
/** Mailed one-time tickets (link in the URL fragment). */
export type AccountMailPurpose = 'verify-email' | 'reset-password' | 'magic-link';
export interface AccountMailer {
  /** Throws 503 when account mail cannot be sent (no transport or no WEB_URL). */
  assertConfigured(): void;
  send(email: string, purpose: AccountMailPurpose, ticket: string, locale: string, userId?: string): Promise<void>;
  /** Optional welcome message once the account can sign in; best effort, a no-op without a transport. */
  welcome?(email: string, locale: string, name: string, userId: string): Promise<void>;
  /** Deletion requested: cancel link with a `cancel-deletion` ticket; best effort. */
  deletionScheduled?(email: string, locale: string, userId: string, notice: { ticket: string; executeAfter: Date }): Promise<void>;
  /** Deletion executed, to the address captured before anonymisation; best effort. */
  deletionCompleted?(email: string, locale: string): Promise<void>;
  /** Staff reset the account's two-factor authentication; best effort. */
  twoFactorReset?(email: string, locale: string, userId: string): Promise<void>;
}
/** `register` result: verification mail sent, or (verification off) a signed-in session. */
export type RegisterResult = { verificationRequired: true }
  | ({ verificationRequired: false } & RefreshTokenPair & { userId: string });
/** Request facts the controller passes to sign-up; never taken from the JSON body. */
export interface RegisterRequestContext { ip?: string }
/**
 * `two-factor` challenges encode how the first factor was proven: `two-factor` (password),
 * `two-factor:magic-link` or `two-factor:oauth:<bindingId>`. Every consumer checks the exact purpose (or
 * this prefix) in the claim validator, so a ticket of one purpose never works for another.
 */
export type TwoFactorChallengePurpose = 'two-factor' | 'two-factor:magic-link' | `two-factor:oauth:${string}`;
export type AccountTicketPurpose = AccountMailPurpose | 'cancel-deletion' | TwoFactorChallengePurpose;
export interface AccountTicket extends OneTimeTicketRecord {
  userId: string;
  /** Address at issue time ('' for accounts without one: two-factor challenges of OAuth accounts). */
  email: string;
  purpose: AccountTicketPurpose;
  credentialVersion: number;
}
export type SessionAuthMethod = 'password' | 'oauth' | 'magic-link';
export interface AccountSession extends PersistentSession { credentialVersion: number; authMethod?: string; oauthBindingId?: string | null }
/** How the first factor was proven at sign-in. */
export type SignInMethod = { kind: 'password' } | { kind: 'magic-link' } | { kind: 'oauth'; bindingId: string };
export type SessionPair = RefreshTokenPair & { userId: string };
/** Either an open session, or a two-factor challenge to complete with `POST /authorize/login/two-factor`. */
export type SignInResult = ({ twoFactorRequired: false } & SessionPair) | { twoFactorRequired: true; challenge: string };
export const ACCESS_TTL_SECONDS = 900;
export const SESSION_TTL_SECONDS = 30 * 86400;
/** Ticket lifetimes (seconds). */
export const TICKET_TTL = { mail: 1800, magicLink: 900, twoFactor: 300 } as const;
/** Usernames with this prefix are reserved for anonymised (deleted) accounts. */
export const DELETED_USERNAME_PREFIX = 'deleted-';
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const ticketHash = (code: string) => createHash('sha256').update(code).digest('hex');
function challengeMethod(purpose: string): SignInMethod | null {
  if (purpose === 'two-factor') return { kind: 'password' };
  if (purpose === 'two-factor:magic-link') return { kind: 'magic-link' };
  const oauth = /^two-factor:oauth:([A-Za-z0-9_-]{1,64})$/.exec(purpose);
  return oauth ? { kind: 'oauth', bindingId: oauth[1]! } : null;
}

function fields(body: unknown, keys: string[]): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid request');
  const entries = Object.entries(body);
  if (entries.some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || value.length > 2048)) {
    throw new BadRequestException('Invalid request fields');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
function emailAddress(value: string | undefined): string {
  const email = value?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Invalid email');
  return email;
}

/** Consumer composition: public account policy, schema mapping and mail copy stay in this template. */
@Injectable()
export class AccountService {
  readonly sessions: PersistentSessionService<AccountSession>;
  private readonly tokens: RefreshTokenService<UserEntity>;
  private readonly logger = new Logger(AccountService.name);
  /** Account mail for verification/reset requests runs after the response, so timing does not reveal accounts. */
  private readonly backgroundMail = new Set<Promise<void>>();
  /** A hash in the default encoder's format, compared for unknown usernames so both paths cost one hash. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly users: UserService,
    private readonly jwt: JwtService,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
    // Optional so narrow compositions (tests) keep today's defaults: open, verification required, no extras.
    @Optional() private readonly onboarding?: AccountOnboarding,
    @Optional() private readonly twoFactor?: AccountTwoFactorService,
    @Optional() @Inject(ACCOUNT_SECURITY_CLOCK) private readonly clock: AccountSecurityClock = systemAccountSecurityClock,
  ) {
    this.sessions = new PersistentSessionService<AccountSession>(db, { modelName: 'accountSessions', sessionTtlMs: SESSION_TTL_SECONDS * 1000 });
    this.tokens = new RefreshTokenService({
      store: new PersistentSessionRefreshTokenStore(this.sessions),
      accessTtlSeconds: ACCESS_TTL_SECONDS,
      refreshTtlSeconds: SESSION_TTL_SECONDS,
      verify: async token => {
        try {
          const claims = await jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
          if (claims.tokenUse !== 'refresh') throw new RefreshTokenError('invalid');
          return { subject: claims.sub, jti: claims.jti };
        } catch { throw new RefreshTokenError('invalid'); }
      },
      loadIdentity: async sessionId => {
        const session = await this.sessions.getSessionById(sessionId);
        const user = session && await users.findById(session.userId);
        return session && user && await this.sessionIdentityAllowed(session, user) ? user : null;
      },
      issue: async (user, claims, lifetime) => ({
        accessToken: await jwt.signAsync({ sub: user.id, username: user.username, sid: claims.subject, tokenUse: 'access' },
          { algorithm: 'HS256', expiresIn: lifetime.accessTtlSeconds, audience: 'zucker:access' }),
        refreshToken: await jwt.signAsync({ sub: claims.subject, jti: claims.jti, tokenUse: 'refresh' },
          { algorithm: 'HS256', expiresIn: lifetime.refreshTtlSeconds, audience: 'zucker:refresh' }),
      }),
    });
  }

  private tickets(db = this.db, expirySeconds: number = TICKET_TTL.mail) {
    return new OneTimeTicketService(new DatabaseOneTimeTicketStore(db.model('accountTickets') as ModelOperations<AccountTicket>), {
      expirySeconds, consumedRetentionSeconds: 86400, now: this.clock,
    });
  }
  /** Issues a one-time account ticket bound to the user's current address and credential version. */
  async issueTicket(user: { id: string; email?: string | null; credentialVersion?: number | null }, purpose: AccountTicketPurpose, expirySeconds: number,
    db: DatabaseAdapter = this.db): Promise<string> {
    return this.tickets(db, expirySeconds).issue({ userId: user.id, email: user.email ?? '', purpose,
      credentialVersion: Number(user.credentialVersion ?? 0) });
  }
  /**
   * Consumes a ticket of exactly `purpose` on `db`: the purpose is checked before the claim (a wrong
   * purpose never burns the ticket), then the account must be enabled with the same address and
   * credential version as at issue time. Throws `OneTimeTicketError` otherwise.
   */
  async consumeTicket(db: DatabaseAdapter, code: string, purpose: AccountTicketPurpose, options: { requireEnabled?: boolean } = {}): Promise<UserEntity> {
    const ticket = await this.tickets(db).consume(code, current => {
      if (current.purpose !== purpose) throw new OneTimeTicketError('invalid');
    });
    const user = await new UserService(db).findById(ticket.userId);
    if (!user || (options.requireEnabled !== false && !user.status) || (user.email ?? '') !== ticket.email
      || ticket.credentialVersion !== Number(user.credentialVersion ?? 0)) throw new OneTimeTicketError('invalid');
    return user;
  }
  /** Background account mail (sending after the response keeps timing and delivery failures private). */
  runInBackground(kind: string, work: () => Promise<void>): void { this.background(kind, work); }
  now(): Date { return this.clock(); }

  /** Current account policy (declared defaults without PolicyModule/AccountOnboarding). */
  policy(): Promise<AccountPolicyValues> { return this.onboarding ? this.onboarding.policy() : readAccountPolicy(undefined); }

  async register(body: unknown, context: RegisterRequestContext = {}): Promise<RegisterResult> {
    const input = fields(body, ['username', 'email', 'password', 'locale', 'utm']);
    const email = emailAddress(input.email);
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    if (input.username.trim().toLowerCase().startsWith(DELETED_USERNAME_PREFIX)) throw new BadRequestException('This username is reserved');
    const locale = input.locale === 'zh' ? 'zh' : 'en';
    const policy = await this.policy();
    if (!policy.registrationOpen) throw new ForbiddenException('Registration is closed');
    const verify = policy.requireEmailVerification;
    // With verification on, refuse before creating an account that could never receive its ticket.
    if (verify) this.mailer.assertConfigured();
    const signup: SignupContext = { method: 'password', ip: context.ip, utmSource: input.utm };
    let created: { user: UserEntity; welcome: SignupWelcome | null };
    try {
      created = await this.db.$transaction(async tx => {
        const existing = await tx.model('users').findMany({ where: { OR: [{ email }, { username: input.username }] }, take: 1 });
        if (existing.length) throw new ConflictException('Account already exists');
        // emailVerified stays false when verification is off: the address is still unproven, and
        // turning the policy back on requires these accounts to verify before their next sign-in.
        const user = await new UserService(tx).addUser({
          username: input.username, password: input.password, email, locale,
          name: input.username, typeId: 'member', status: true, emailVerified: false,
        });
        return { user, welcome: this.onboarding ? await this.onboarding.recordSignup(tx, user.id, signup, policy) : null };
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new ConflictException('Account already exists');
      throw error;
    }
    const { user, welcome } = created;
    await this.onboarding?.afterSignup(user.id, welcome);
    if (verify) {
      await this.deliverTicket(user, 'verify-email');
      return { verificationRequired: true };
    }
    this.background('welcome', () => this.sendWelcome(user));
    return { verificationRequired: false, ...await this.openSession(user, { kind: 'password' }) };
  }

  /** Account-related mail runs after the response, so its timing and failures never reach the caller. */
  private background(kind: string, work: () => Promise<void>): void {
    const delivery = work()
      .catch(error => { this.logger.warn(`Account ${kind} mail failed: ${error instanceof Error ? error.name : 'Error'}`); })
      .finally(() => { this.backgroundMail.delete(delivery); });
    this.backgroundMail.add(delivery);
  }
  /** Welcome mail to an address the account controls; skipped without a transport or an address. */
  async sendWelcome(user: Pick<UserEntity, 'id' | 'email' | 'locale' | 'name' | 'username'>): Promise<void> {
    if (!user.email || !this.mailer.welcome) return;
    await this.mailer.welcome(user.email, user.locale ?? 'en', user.name || user.username, user.id);
  }
  /** OAuth (or another trusted path) created an account: welcome credits now, welcome mail in the background. */
  async completeProviderSignup(user: Pick<UserEntity, 'id' | 'email' | 'emailVerified' | 'locale' | 'name' | 'username'>,
    welcome: SignupWelcome | null): Promise<void> {
    await this.onboarding?.afterSignup(user.id, welcome);
    if (user.emailVerified) this.background('welcome', () => this.sendWelcome(user));
  }

  private async deliverTicket(user: UserEntity, purpose: AccountMailPurpose): Promise<void> {
    if (!user.email) return;
    const code = await this.issueTicket(user, purpose, purpose === 'magic-link' ? TICKET_TTL.magicLink : TICKET_TTL.mail);
    await this.mailer.send(user.email, purpose, code, user.locale ?? 'en', user.id);
  }

  async requestEmail(body: unknown, purpose: 'verify-email' | 'reset-password'): Promise<{ accepted: true }> {
    const input = fields(body, ['email']);
    const email = emailAddress(input.email);
    this.mailer.assertConfigured();
    const rows = await this.db.model('users').findMany({ where: { email }, take: 1 }) as UserEntity[];
    const user = rows[0];
    if (user?.status && (purpose === 'reset-password' || !user.emailVerified)) this.background(purpose, () => this.deliverTicket(user, purpose));
    return { accepted: true };
  }
  /** Waits for verification/reset mail started by earlier requests (tests and graceful shutdown). */
  async settled(): Promise<void> {
    while (this.backgroundMail.size) await Promise.all([...this.backgroundMail]);
  }
  async onApplicationShutdown(): Promise<void> { await this.settled(); }

  async consumeEmail(body: unknown, purpose: 'verify-email' | 'reset-password'): Promise<{ success: true }> {
    const input = fields(body, purpose === 'reset-password' ? ['ticket', 'password'] : ['ticket']);
    if (!input.ticket || !TICKET.test(input.ticket)) throw new BadRequestException('Invalid ticket');
    if (purpose === 'reset-password' && !input.password) throw new BadRequestException('Password is required');
    let verified: UserEntity | null = null;
    try {
      await this.db.$transaction(async tx => {
        // Purpose is checked before the claim: a ticket of another purpose is refused and stays usable.
        const user = await this.consumeTicket(tx, input.ticket, purpose);
        if (purpose === 'verify-email') {
          await tx.model('users').update({ where: { id: user.id }, data: { emailVerified: true } });
          verified = user;
        } else {
          await this.replacePassword(tx, user, input.password, 'password-reset');
        }
      });
    } catch (error) {
      if (error instanceof OneTimeTicketError) throw new BadRequestException('Invalid or expired ticket');
      throw error;
    }
    const welcomed = verified as UserEntity | null;
    if (welcomed) this.background('welcome', () => this.sendWelcome(welcomed));
    return { success: true };
  }

  private async replacePassword(tx: DatabaseAdapter, user: UserEntity, password: string, reason: string): Promise<void> {
    const changed = await tx.model('users').updateMany({
      where: { id: user.id, credentialVersion: Number(user.credentialVersion ?? 0) },
      data: { credentialVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OneTimeTicketError('invalid');
    await new UserService(tx).updateUser(user.id, { password });
    await tx.model('accountSessions').updateMany({ where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason } });
  }

  async changePassword(userId: string, body: unknown): Promise<{ success: true }> {
    const input = fields(body, ['currentPassword', 'password']);
    if (!input.currentPassword || !input.password) throw new BadRequestException('Current and new password are required');
    await this.db.$transaction(async tx => {
      const users = new UserService(tx);
      const current = await users.findById(userId);
      const checked = current && await users.findByUsernameAndPassword(current.username, input.currentPassword);
      if (!checked?.status) throw new UnauthorizedException('Invalid current password');
      await this.replacePassword(tx, checked, input.password, 'password-change');
    });
    return { success: true };
  }

  async updateProfile(userId: string, body: unknown): Promise<{ success: true }> {
    const input = fields(body, ['name', 'locale']);
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 100)) throw new BadRequestException('Invalid name');
    if (input.locale !== undefined && !['en', 'zh'].includes(input.locale)) throw new BadRequestException('Invalid locale');
    await this.users.updateUser(userId, input);
    return { success: true };
  }

  async login(body: unknown): Promise<SignInResult> {
    const input = fields(body, ['username', 'password']);
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    const user = await this.verifyPassword(input.username, input.password);
    if (!user?.status || !await this.emailRequirementMet(user)) throw new UnauthorizedException('Invalid credentials or email not verified');
    return this.completeSignIn(user, { kind: 'password' });
  }

  /**
   * The account whose password matches, or null. Unknown usernames and password-less accounts cost the
   * same one hash as a wrong password, so timing does not reveal which accounts exist.
   */
  async verifyPassword(username: string, password: string): Promise<UserEntity | null> {
    const known = await this.users.findByUsername(username);
    if (!known?.password) {
      this.dummyHash ??= new BcryptEncoder().encode(randomUUID());
      await new BcryptEncoder().matches(password, await this.dummyHash);
      return null;
    }
    return this.users.findByUsernameAndPassword(username, password);
  }

  /**
   * The one place every interactive sign-in ends (password, OAuth/One Tap, magic link): refuses an
   * account with a scheduled deletion (403 `ACCOUNT_DELETION_PENDING`), returns a two-factor challenge
   * for enrolled accounts (fails closed with 503 when secrets cannot be read), otherwise opens the
   * session. Callers have already proven the first factor. API keys never pass through here.
   */
  async completeSignIn(user: UserEntity, method: SignInMethod): Promise<SignInResult> {
    await this.assertNoPendingDeletion(user.id);
    if (await this.twoFactorActive(user.id)) {
      if (!this.twoFactor?.available()) throw accountSecurityError(503, E.twoFactorUnavailable, 'Two-factor authentication is not configured on this server');
      const purpose: TwoFactorChallengePurpose = method.kind === 'password' ? 'two-factor'
        : method.kind === 'magic-link' ? 'two-factor:magic-link' : `two-factor:oauth:${method.bindingId}`;
      return { twoFactorRequired: true, challenge: await this.issueTicket(user, purpose, TICKET_TTL.twoFactor) };
    }
    return { twoFactorRequired: false, ...await this.openSession(user, method) };
  }

  /** Enrolment state read straight from the table, so compositions without the service still fail closed. */
  private async twoFactorActive(userId: string, db: DatabaseAdapter = this.db): Promise<boolean> {
    const row = await db.model('accountTwoFactor').findUnique({ where: { userId }, select: { status: true } }) as { status: string } | null;
    return row?.status === 'active';
  }

  /** 403 `ACCOUNT_DELETION_PENDING` (with `details.executeAfter`) while a deletion is scheduled. */
  async assertNoPendingDeletion(userId: string, db: DatabaseAdapter = this.db): Promise<void> {
    const row = await db.model('accountDeletions').findUnique({ where: { userId }, select: { status: true, executeAfter: true } }) as
      { status: string; executeAfter: Date } | null;
    if (row?.status === 'scheduled') {
      throw accountSecurityError(403, E.deletionPending, 'This account is scheduled for deletion', { executeAfter: row.executeAfter.toISOString() });
    }
  }

  /**
   * Account id of a well-formed, unconsumed, unexpired two-factor challenge, or undefined. Only used to
   * key the per-account login budget before the code is checked; `loginTwoFactor` is the authority.
   */
  async twoFactorChallengeSubject(body: unknown): Promise<string | undefined> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const challenge = (body as Record<string, unknown>).challenge;
    if (typeof challenge !== 'string' || !TICKET.test(challenge)) return undefined;
    const ticket = await this.db.model('accountTickets').findUnique({ where: { tokenHash: ticketHash(challenge) },
      select: { userId: true, purpose: true, consumedAt: true, expiresAt: true } }) as
      { userId: string; purpose: string; consumedAt: Date | null; expiresAt: Date } | null;
    return ticket && challengeMethod(ticket.purpose) && !ticket.consumedAt && ticket.expiresAt > this.clock() ? ticket.userId : undefined;
  }

  /**
   * Second step of an enrolled sign-in: `{ challenge, code }` or `{ challenge, recoveryCode }`. A wrong
   * code leaves the challenge usable (it counts toward the TOTP lockout and the caller's login budgets);
   * a correct one spends the factor and the challenge in one transaction, then opens the session of the
   * method encoded in the challenge.
   */
  async loginTwoFactor(body: unknown): Promise<SessionPair> {
    const input = fields(body, ['challenge', 'code', 'recoveryCode']);
    const factor = secondFactor(input);
    if (!input.challenge || !TICKET.test(input.challenge)) throw accountSecurityError(400, E.twoFactorChallengeInvalid, 'Invalid or expired sign-in challenge');
    if (!factor) throw accountSecurityError(400, E.twoFactorCodeInvalid, 'Enter a 6-digit code or a recovery code');
    if (!this.twoFactor) throw accountSecurityError(503, E.twoFactorUnavailable, 'Two-factor authentication is not configured on this server');
    const twoFactor = this.twoFactor;
    let signedIn: { user: UserEntity; method: SignInMethod };
    try {
      signedIn = await this.db.$transaction(async tx => {
        const peek = await tx.model('accountTickets').findUnique({ where: { tokenHash: ticketHash(input.challenge) } }) as AccountTicket | null;
        const method = peek && challengeMethod(peek.purpose);
        if (!peek || !method || peek.consumedAt || peek.expiresAt <= this.clock()) throw new OneTimeTicketError('invalid');
        if (!await twoFactor.verify(tx, peek.userId, factor)) {
          throw accountSecurityError(401, E.twoFactorCodeInvalid, 'Invalid code');
        }
        const user = await this.consumeTicket(tx, input.challenge, peek.purpose);
        return { user, method };
      });
    } catch (error) {
      if (error instanceof OneTimeTicketError) throw accountSecurityError(400, E.twoFactorChallengeInvalid, 'Invalid or expired sign-in challenge');
      throw error;
    }
    await this.assertNoPendingDeletion(signedIn.user.id);
    if (signedIn.method.kind === 'oauth') {
      const binding = await this.db.model('thirdPartyBinds').findUnique({ where: { id: signedIn.method.bindingId } }) as { userId: string } | null;
      if (binding?.userId !== signedIn.user.id) throw new UnauthorizedException('Provider account is unavailable');
    }
    return this.openSession(signedIn.user, signedIn.method);
  }

  /**
   * "Email me a sign-in link" (account policy `magicLinkEnabled`). Always `{accepted: true}`: a link is
   * mailed in the background only to an existing, enabled account without a scheduled deletion, so the
   * response never reveals whether the address is registered. Never creates an account (D17).
   */
  async requestMagicLink(body: unknown): Promise<{ accepted: true }> {
    const input = fields(body, ['email']);
    const email = emailAddress(input.email);
    if (!(await this.policy()).magicLinkEnabled) throw accountSecurityError(403, E.magicLinkDisabled, 'Sign-in links are turned off');
    this.mailer.assertConfigured();
    const rows = await this.db.model('users').findMany({ where: { email }, take: 1 }) as UserEntity[];
    const user = rows[0];
    if (user?.status && !user.username.startsWith(DELETED_USERNAME_PREFIX)) {
      this.background('magic-link', async () => {
        const pending = await this.db.model('accountDeletions').findUnique({ where: { userId: user.id }, select: { status: true } }) as { status: string } | null;
        if (pending?.status !== 'scheduled') await this.deliverTicket(user, 'magic-link');
      });
    }
    return { accepted: true };
  }

  /** Consumes a mailed sign-in link: the address is now proven (emailVerified), then the normal sign-in ending. */
  async consumeMagicLink(body: unknown): Promise<SignInResult> {
    const input = fields(body, ['ticket']);
    if (!input.ticket || !TICKET.test(input.ticket)) throw new BadRequestException('Invalid ticket');
    if (!(await this.policy()).magicLinkEnabled) throw accountSecurityError(403, E.magicLinkDisabled, 'Sign-in links are turned off');
    let user: UserEntity;
    try {
      user = await this.db.$transaction(async tx => {
        const found = await this.consumeTicket(tx, input.ticket, 'magic-link');
        if (!found.emailVerified) await tx.model('users').update({ where: { id: found.id }, data: { emailVerified: true } });
        return { ...found, emailVerified: true };
      });
    } catch (error) {
      if (error instanceof OneTimeTicketError) throw new BadRequestException('Invalid or expired ticket');
      throw error;
    }
    return this.completeSignIn(user, { kind: 'magic-link' });
  }

  /**
   * Recent authentication for sensitive account changes (2FA enrol/disable/regenerate, deletion): the
   * account password when the account has one; for password-less accounts the session must have been
   * opened within the last 10 minutes. 403 `RECENT_AUTHENTICATION_REQUIRED` / `_FAILED` (never 401,
   * which clients treat as an expired session).
   */
  async assertRecentAuthentication(userId: string, sessionId: string, password: string | undefined): Promise<UserEntity> {
    const user = await this.currentUser(userId, sessionId);
    if (user.password) {
      if (typeof password !== 'string' || !password) throw accountSecurityError(403, E.recentAuthenticationRequired, 'Enter your password to continue');
      const checked = await this.users.findByUsernameAndPassword(user.username, password);
      if (!checked || checked.id !== user.id) throw accountSecurityError(403, E.recentAuthenticationFailed, 'The password is not correct');
      return user;
    }
    const session = await this.db.model('accountSessions').findUnique({ where: { id: sessionId }, select: { createdAt: true } }) as { createdAt: Date } | null;
    if (!session || this.clock().getTime() - session.createdAt.getTime() > RECENT_SESSION_MS) {
      throw accountSecurityError(403, E.recentAuthenticationRequired, 'Sign in again to continue');
    }
    return user;
  }

  private async openSession(user: UserEntity, method: SignInMethod): Promise<SessionPair> {
    const authMethod: SessionAuthMethod = method.kind;
    const session = await this.sessions.createSession({ id: randomUUID(), userId: user.id, refreshJti: randomUUID(),
      revokedAt: null, lastActiveAt: this.clock(), credentialVersion: Number(user.credentialVersion ?? 0), authMethod,
      oauthBindingId: method.kind === 'oauth' ? method.bindingId : null });
    try {
      return { ...await this.tokens.login(session.id, user), userId: user.id };
    } catch (error) {
      await this.sessions.revokeSession(session.id, 'login-failed');
      throw error;
    }
  }

  async providerLogin(userId: string, bindingId: string): Promise<SignInResult> {
    const user = await this.users.findById(userId);
    const binding = await this.db.model('thirdPartyBinds').findUnique({ where: { id: bindingId } }) as { userId: string } | null;
    if (!user?.status || binding?.userId !== userId) throw new UnauthorizedException('Provider account is unavailable');
    return this.completeSignIn(user, { kind: 'oauth', bindingId });
  }

  private async sessionIdentityAllowed(session: AccountSession, user: UserEntity, db = this.db): Promise<boolean> {
    if (!user.status || session.credentialVersion !== Number(user.credentialVersion ?? 0)) return false;
    if (session.authMethod === 'oauth') {
      if (!session.oauthBindingId) return false;
      const binding = await db.model('thirdPartyBinds').findUnique({ where: { id: session.oauthBindingId } }) as { userId: string } | null;
      return binding?.userId === user.id;
    }
    // A magic-link session proved the address when it was opened; an admin e-mail change bumps credentialVersion.
    if (session.authMethod === 'magic-link') return user.emailVerified === true;
    return (session.authMethod === undefined || session.authMethod === 'password') && await this.emailRequirementMet(user);
  }
  /** Password accounts need a verified address only while the policy requires verification (read-through, cached). */
  private async emailRequirementMet(user: UserEntity): Promise<boolean> {
    return user.emailVerified === true || !(await this.policy()).requireEmailVerification;
  }

  /** Read the current HttpOnly session without rotating it, for browser-bound OAuth callbacks. */
  async browserSession(token: string): Promise<{ id: string; sid: string }> {
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
      if (claims.tokenUse !== 'refresh' || typeof claims.sub !== 'string') throw new Error();
      const session = await this.sessions.getSessionById(claims.sub);
      if (!session || session.refreshJti !== claims.jti) throw new Error();
      await this.currentUser(session.userId, session.id);
      return { id: session.userId, sid: session.id };
    } catch { throw new UnauthorizedException('Invalid or expired session'); }
  }

  /**
   * Session id of a correctly signed, unexpired refresh token that is still the session's current
   * token, or null. Used only as the per-session rate-limit key: a leaked, already rotated token
   * must not spend the victim session's budget (it stays on the per-IP network budget). refresh()
   * remains the authority on rotation and replay.
   */
  async refreshSessionId(token: string): Promise<string | null> {
    if (!token) return null;
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
      if (claims.tokenUse !== 'refresh' || typeof claims.sub !== 'string' || !claims.sub) return null;
      const session = await this.sessions.getSessionById(claims.sub);
      return session && session.refreshJti === claims.jti ? claims.sub : null;
    } catch { return null; }
  }

  async refresh(token: string): Promise<RefreshTokenPair> {
    try { return await this.tokens.refresh(token); }
    catch (error) {
      if (error instanceof RefreshTokenError) throw new UnauthorizedException('Invalid or expired session');
      throw error;
    }
  }

  async currentUser(userId: string, sessionId: string, db = this.db): Promise<UserEntity> {
    const session = await db.model('accountSessions').findUnique({ where: { id: sessionId } }) as AccountSession | null;
    const user = await new UserService(db).findById(userId);
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date() || !user
      || !await this.sessionIdentityAllowed(session, user, db)) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    return user;
  }
}
