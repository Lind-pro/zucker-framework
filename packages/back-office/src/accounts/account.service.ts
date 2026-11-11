import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional, UnauthorizedException, type OnApplicationShutdown,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter, type ModelOperations } from '@zucker-framework/core';
import {
  BcryptEncoder, DatabaseOneTimeTicketStore, DatabaseVerificationCodeStore, OneTimeTicketError, OneTimeTicketService, PersistentSessionRefreshTokenStore,
  PersistentSessionService, PostgresIdentityTransactions, RefreshTokenError, RefreshTokenService, UserService, VerificationCodeError, VerificationCodeService,
  type OneTimeTicketRecord, type PasswordEncoder, type PersistentSession, type RefreshTokenPair, type UserEntity, type VerificationAttemptStore,
  type VerificationCodeRecord,
} from '@zucker-framework/auth';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError, emailAddress, RECENT_SESSION_MS, requiredFields, systemAccountSecurityClock, type AccountSecurityClock } from './account-security';
import { accountLocale, requireSql, resolveAccountsOptions, type ResolvedAccountsOptions } from './accounts.options';
import {
  DEFAULT_ACCOUNT_POLICY, type AccountMailDelivery, type AccountMailer, type AccountMailPurpose, type AccountPolicy, type AccountPolicySource,
  type AccountSignupHooks, type SignupContext,
} from './accounts.ports';
import {
  ACCOUNTS_CLOCK, ACCOUNTS_MAILER, ACCOUNTS_OPTIONS, ACCOUNTS_PASSWORD_ENCODER, ACCOUNTS_POLICY, ACCOUNTS_SIGNUP_HOOKS, ACCOUNTS_VERIFICATION_ATTEMPTS,
} from './accounts.tokens';
import { AccountTwoFactorService, secondFactor } from './two-factor/two-factor.service';

/** `register` result: verification mail sent, or (verification off) a signed-in session. */
export type RegisterResult = { verificationRequired: true }
  | ({ verificationRequired: false } & RefreshTokenPair & { userId: string });
/** Request facts the controller passes to sign-up; never taken from the JSON body. */
export interface RegisterRequestContext { ip?: string }
/**
 * `two-factor` challenges encode how the first factor was proven: `two-factor` (password),
 * `two-factor:magic-link`, `two-factor:oauth:<bindingId>` or `two-factor:method:<name>`. Every consumer
 * checks the exact purpose in the claim validator, so a ticket of one purpose never works for another.
 */
export type TwoFactorChallengePurpose = 'two-factor' | 'two-factor:magic-link' | `two-factor:oauth:${string}` | `two-factor:method:${string}`;
export type AccountTicketPurpose = AccountMailPurpose | 'cancel-deletion' | TwoFactorChallengePurpose;
export interface AccountTicket extends OneTimeTicketRecord {
  userId: string;
  /** Address at issue time ('' for accounts without one: two-factor challenges of OAuth accounts). */
  email: string;
  purpose: AccountTicketPurpose;
  credentialVersion: number;
}
export interface AccountSession extends PersistentSession { credentialVersion: number; authMethod?: string; oauthBindingId?: string | null }
/** How the first factor was proven at sign-in. `method` = a product method registered in `signInMethods`. */
export type SignInMethod = { kind: 'password' } | { kind: 'magic-link' } | { kind: 'oauth'; bindingId: string } | { kind: 'method'; name: string };
export type SessionPair = RefreshTokenPair & { userId: string };
/** Either an open session, or a two-factor challenge to complete with `POST /authorize/login/two-factor`. */
export type SignInResult = ({ twoFactorRequired: false } & SessionPair) | { twoFactorRequired: true; challenge: string };
/** `verify-email` / `reset-password` result; with `verification.signInOnVerify` a verified address also signs in. */
export type ConsumeEmailResult = { success: true; signIn?: SignInResult };
/** Usernames with this prefix are reserved for anonymised (deleted) accounts. */
export const DELETED_USERNAME_PREFIX = 'deleted-';
/** Built-in product method of verification mode `'code'`: the six-digit code proved the address. */
export const EMAIL_CODE_METHOD = 'email-code';

const TICKET = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;
const ticketHash = (code: string) => createHash('sha256').update(code).digest('hex');
interface TopicEventBusLike { publish(topic: string, payload: unknown): Promise<void> }

/**
 * The account host: sign-up, credential mail (tickets or six-digit codes), password sign-in, refresh
 * rotation, two-factor step-up, magic links and session checks. Every interactive sign-in ends in
 * `completeSignIn` (pending deletion → 403, enrolled two-factor → challenge, else a session); products
 * add their own sign-in methods through `signIn(user, name)`.
 */
@Injectable()
export class AccountService implements OnApplicationShutdown {
  readonly options: ResolvedAccountsOptions;
  readonly sessions: PersistentSessionService<AccountSession>;
  private readonly tokens: RefreshTokenService<UserEntity>;
  private readonly logger = new Logger(AccountService.name);
  /** Account mail for verification/reset requests runs after the response, so timing does not reveal accounts. */
  private readonly backgroundMail = new Set<Promise<void>>();
  /** A hash in the configured encoder's format, compared for unknown usernames so both paths cost one hash. */
  private dummyHash?: Promise<string>;
  private readonly encoder: PasswordEncoder;
  private codeService?: VerificationCodeService<DatabaseAdapter>;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly jwt: JwtService,
    @Inject(ACCOUNTS_MAILER) private readonly mailer: AccountMailer,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions,
    @Optional() @Inject(ACCOUNTS_POLICY) private readonly policySource?: AccountPolicySource,
    @Optional() @Inject(ACCOUNTS_SIGNUP_HOOKS) private readonly signupHooks?: AccountSignupHooks,
    @Optional() private readonly twoFactor?: AccountTwoFactorService,
    @Optional() @Inject(ACCOUNTS_CLOCK) private readonly clock: AccountSecurityClock = systemAccountSecurityClock,
    @Optional() @Inject(ACCOUNTS_PASSWORD_ENCODER) encoder?: PasswordEncoder,
    @Optional() @Inject(ACCOUNTS_VERIFICATION_ATTEMPTS) private readonly attempts?: VerificationAttemptStore,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly eventBus?: TopicEventBusLike,
  ) {
    this.options = options ?? resolveAccountsOptions();
    const configured = this.options.passwordEncoder;
    this.encoder = encoder ?? (configured && typeof configured === 'object' ? configured : new BcryptEncoder());
    const { models, tokens: policy } = this.options;
    this.sessions = new PersistentSessionService<AccountSession>(db, { modelName: models.accountSessions, sessionTtlMs: policy.refreshTtlSeconds * 1000 });
    this.tokens = new RefreshTokenService({
      store: new PersistentSessionRefreshTokenStore(this.sessions),
      accessTtlSeconds: policy.accessTtlSeconds,
      refreshTtlSeconds: policy.refreshTtlSeconds,
      verify: async token => {
        try {
          const claims = await jwt.verifyAsync(token, { algorithms: ['HS256'], audience: policy.refreshAudience });
          if (claims.tokenUse !== 'refresh') throw new RefreshTokenError('invalid');
          return { subject: claims.sub, jti: claims.jti };
        } catch { throw new RefreshTokenError('invalid'); }
      },
      loadIdentity: async sessionId => {
        const session = await this.sessions.getSessionById(sessionId);
        const user = session && await this.users().findById(session.userId);
        return session && user && await this.sessionIdentityAllowed(session, user) ? user : null;
      },
      issue: async (user, claims, lifetime) => ({
        accessToken: await jwt.signAsync({ ...policy.extraClaims(user), sub: user.id, sid: claims.subject, tokenUse: 'access' },
          { algorithm: 'HS256', expiresIn: lifetime.accessTtlSeconds, audience: policy.accessAudience }),
        refreshToken: await jwt.signAsync({ sub: claims.subject, jti: claims.jti, tokenUse: 'refresh' },
          { algorithm: 'HS256', expiresIn: lifetime.refreshTtlSeconds, audience: policy.refreshAudience }),
      }),
    });
  }

  /** `UserService` on `db` with the configured password encoder (and the lifecycle event bus when present). */
  users(db: DatabaseAdapter = this.db): UserService {
    return new UserService(db, this.encoder, this.eventBus);
  }
  private model(name: keyof ResolvedAccountsOptions['models'], db: DatabaseAdapter = this.db): ModelOperations {
    return db.model(this.options.models[name]);
  }
  private tickets(db = this.db, expirySeconds: number = this.options.tickets.mailSeconds) {
    return new OneTimeTicketService(new DatabaseOneTimeTicketStore(this.model('accountTickets', db) as ModelOperations<AccountTicket>), {
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
    const user = await this.users(db).findById(ticket.userId);
    if (!user || (options.requireEnabled !== false && !user.status) || (user.email ?? '') !== ticket.email
      || ticket.credentialVersion !== Number(user.credentialVersion ?? 0)) throw new OneTimeTicketError('invalid');
    return user;
  }

  /**
   * Six-digit codes (verification mode `'code'`, and product login methods): at most one live code per
   * address and purpose, a resend window, and a failed-attempt lockout. `consumeCode` runs `apply` in the
   * transaction that claims the code, so the account change and the claim commit together.
   */
  private codes(): VerificationCodeService<DatabaseAdapter> {
    if (this.codeService) return this.codeService;
    const attempts = this.attempts ?? (typeof this.options.verification.attempts === 'object' ? this.options.verification.attempts : undefined);
    if (!attempts) throw accountSecurityError(503, E.verificationUnavailable, 'Verification codes are not configured');
    const transactions = new PostgresIdentityTransactions<DatabaseAdapter>({ namespace: 'account-verification',
      transaction: work => this.db.$transaction(work),
      query: (tx, sql, values) => requireSql(this.options, tx, 'Verification codes').query(sql, values) });
    const { subject, purpose } = this.options.verification.fields;
    this.codeService = new VerificationCodeService(new DatabaseVerificationCodeStore<DatabaseAdapter>({ transactions,
      model: tx => this.model('emailVerifications', tx) as unknown as ModelOperations<VerificationCodeRecord>, subjectField: subject, purposeField: purpose }),
    attempts, { expirySeconds: this.options.verification.codeExpirySeconds, resendSeconds: this.options.verification.resendSeconds, now: this.clock });
    return this.codeService;
  }
  issueCode(email: string, purpose: string): Promise<{ issued: true; code: string } | { issued: false; waitSeconds: number }> {
    return this.codes().issue(email, purpose);
  }
  async consumeCode<T>(email: string, purpose: string, code: string, apply: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (typeof code !== 'string' || !CODE.test(code.trim())) throw accountSecurityError(400, E.verificationCodeInvalid, 'Invalid or expired code');
    try { return await this.codes().consume(email, purpose, code.trim(), apply); }
    catch (error) {
      if (!(error instanceof VerificationCodeError)) throw error;
      if (error.reason === 'locked') throw accountSecurityError(429, E.verificationLocked, 'Too many attempts; try again later', { retryAfter: error.waitSeconds });
      if (error.reason === 'unavailable') throw accountSecurityError(503, E.verificationUnavailable, 'Verification is temporarily unavailable');
      throw accountSecurityError(400, E.verificationCodeInvalid, 'Invalid or expired code');
    }
  }

  /** Background account mail (sending after the response keeps timing and delivery failures private). */
  runInBackground(kind: string, work: () => Promise<void>): void { this.background(kind, work); }
  now(): Date { return this.clock(); }

  /** Current account policy (declared defaults without a policy source). */
  policy(): Promise<AccountPolicy> { return this.policySource ? this.policySource.policy() : Promise.resolve(DEFAULT_ACCOUNT_POLICY); }

  async register(body: unknown, context: RegisterRequestContext = {}): Promise<RegisterResult> {
    const input = requiredFields(body, ['username', 'email', 'password', 'locale', 'utm']);
    const email = emailAddress(input.email);
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    if (input.username.trim().toLowerCase().startsWith(DELETED_USERNAME_PREFIX)) throw new BadRequestException('This username is reserved');
    const locale = accountLocale(this.options, input.locale);
    const policy = await this.policy();
    if (!policy.registrationOpen) throw new ForbiddenException('Registration is closed');
    const verify = policy.requireEmailVerification;
    // With verification on, refuse before creating an account that could never receive its secret.
    if (verify) this.mailer.assertConfigured();
    const signup: SignupContext = { method: 'password', ip: context.ip, utmSource: input.utm };
    let created: { user: UserEntity; recorded: unknown };
    try {
      created = await this.db.$transaction(async tx => {
        const existing = await this.model('users', tx).findMany({ where: { OR: [{ email }, { username: input.username }] }, take: 1 });
        if (existing.length) throw new ConflictException('Account already exists');
        // emailVerified stays false when verification is off: the address is still unproven, and
        // turning the policy back on requires these accounts to verify before their next sign-in.
        const user = await this.users().addUser({
          username: input.username, password: input.password, email, locale,
          name: input.username, typeId: 'member', status: true, emailVerified: false,
        }, { transaction: tx });
        return { user, recorded: this.signupHooks ? await this.signupHooks.recordSignup(tx, user.id, signup, policy) : null };
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new ConflictException('Account already exists');
      throw error;
    }
    const { user, recorded } = created;
    await this.signupHooks?.afterSignup(user.id, recorded);
    if (verify) {
      await this.deliverSecret(user, 'verify-email');
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
    await this.mailer.welcome(user.email, user.locale ?? this.options.locales.default, user.name || user.username, user.id);
  }
  /** A trusted path (OAuth, a product method) created an account: sign-up hooks after commit, welcome mail in the background. */
  async completeProviderSignup(user: Pick<UserEntity, 'id' | 'email' | 'emailVerified' | 'locale' | 'name' | 'username'>, recorded: unknown): Promise<void> {
    await this.signupHooks?.afterSignup(user.id, recorded);
    if (user.emailVerified) this.background('welcome', () => this.sendWelcome(user));
  }
  /** Product sign-up hooks inside the caller's user-creation transaction (returns what `completeProviderSignup` needs). */
  recordSignup(tx: DatabaseAdapter, userId: string, context: SignupContext, policy: AccountPolicy): Promise<unknown> {
    return this.signupHooks ? this.signupHooks.recordSignup(tx, userId, context, policy) : Promise.resolve(null);
  }

  /** Mails a ticket link, or in code mode a six-digit code (nothing when the resend window is still open). */
  private async deliverSecret(user: UserEntity, purpose: AccountMailPurpose): Promise<void> {
    if (!user.email) return;
    const locale = user.locale ?? this.options.locales.default;
    if (this.options.verification.mode === 'code' && purpose !== 'magic-link') {
      const issued = await this.issueCode(user.email, purpose);
      if (!issued.issued) return;
      const delivery: AccountMailDelivery = { kind: 'code', expiresInSeconds: this.options.verification.codeExpirySeconds };
      if (this.mailer.code) await this.mailer.code(user.email, purpose, issued.code, locale, user.id, Math.ceil(delivery.expiresInSeconds / 60));
      else await this.mailer.send(user.email, purpose, issued.code, locale, user.id, delivery);
      return;
    }
    const expiry = purpose === 'magic-link' ? this.options.tickets.magicLinkSeconds : this.options.tickets.mailSeconds;
    const ticket = await this.issueTicket(user, purpose, expiry);
    await this.mailer.send(user.email, purpose, ticket, locale, user.id);
  }

  async requestEmail(body: unknown, purpose: 'verify-email' | 'reset-password'): Promise<{ accepted: true }> {
    const input = requiredFields(body, ['email']);
    const email = emailAddress(input.email);
    this.mailer.assertConfigured();
    const rows = await this.model('users').findMany({ where: { email }, take: 1 }) as UserEntity[];
    const user = rows[0];
    if (user?.status && (purpose === 'reset-password' || !user.emailVerified)) this.background(purpose, () => this.deliverSecret(user, purpose));
    return { accepted: true };
  }
  /** Waits for verification/reset mail started by earlier requests (tests and graceful shutdown). */
  async settled(): Promise<void> {
    while (this.backgroundMail.size) await Promise.all([...this.backgroundMail]);
  }
  async onApplicationShutdown(): Promise<void> { await this.settled(); }

  /**
   * `verify-email` / `reset-password`: `{ticket[, password]}` (ticket mode) or `{email, code[, password]}`
   * (code mode). A verified address signs in when `verification.signInOnVerify` is set.
   */
  async consumeEmail(body: unknown, purpose: 'verify-email' | 'reset-password'): Promise<ConsumeEmailResult> {
    const code = this.options.verification.mode === 'code';
    const keys = code ? ['email', 'code'] : ['ticket'];
    const input = requiredFields(body, purpose === 'reset-password' ? [...keys, 'password'] : keys);
    if (!code && (!input.ticket || !TICKET.test(input.ticket))) throw new BadRequestException('Invalid ticket');
    if (purpose === 'reset-password' && !input.password) throw new BadRequestException('Password is required');
    const apply = async (tx: DatabaseAdapter, user: UserEntity): Promise<UserEntity | null> => {
      if (purpose === 'reset-password') { await this.replacePassword(tx, user, input.password!, 'password-reset'); return null; }
      await this.model('users', tx).update({ where: { id: user.id }, data: { emailVerified: true } });
      return { ...user, emailVerified: true };
    };
    let verified: UserEntity | null;
    if (code) {
      const email = emailAddress(input.email);
      verified = await this.consumeCode(email, purpose, input.code ?? '', async tx => {
        const user = (await this.model('users', tx).findMany({ where: { email }, take: 1 }) as UserEntity[])[0];
        if (!user?.status) throw new VerificationCodeError('invalid');
        // A concurrent credential change (optimistic credentialVersion) rolls the claim back like a wrong code.
        try { return await apply(tx, user); }
        catch (error) { throw error instanceof OneTimeTicketError ? new VerificationCodeError('invalid') : error; }
      });
    } else {
      try {
        // Purpose is checked before the claim: a ticket of another purpose is refused and stays usable.
        verified = await this.db.$transaction(async tx => apply(tx, await this.consumeTicket(tx, input.ticket!, purpose)));
      } catch (error) {
        if (error instanceof OneTimeTicketError) throw new BadRequestException('Invalid or expired ticket');
        throw error;
      }
    }
    if (!verified) return { success: true };
    const welcomed = verified;
    this.background('welcome', () => this.sendWelcome(welcomed));
    if (!this.options.verification.signInOnVerify) return { success: true };
    return { success: true, signIn: await this.completeSignIn(welcomed, code ? { kind: 'method', name: EMAIL_CODE_METHOD } : { kind: 'password' }) };
  }

  private async replacePassword(tx: DatabaseAdapter, user: UserEntity, password: string, reason: string): Promise<void> {
    const changed = await this.model('users', tx).updateMany({
      where: { id: user.id, credentialVersion: Number(user.credentialVersion ?? 0) },
      data: { credentialVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OneTimeTicketError('invalid');
    await this.users(tx).updateUser(user.id, { password });
    await this.model('accountSessions', tx).updateMany({ where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason } });
  }

  async changePassword(userId: string, body: unknown): Promise<{ success: true }> {
    const input = requiredFields(body, ['currentPassword', 'password']);
    if (!input.currentPassword || !input.password) throw new BadRequestException('Current and new password are required');
    await this.db.$transaction(async tx => {
      const users = this.users(tx);
      const current = await users.findById(userId);
      const checked = current && await users.findByUsernameAndPassword(current.username, input.currentPassword!);
      if (!checked?.status) throw new UnauthorizedException('Invalid current password');
      await this.replacePassword(tx, checked, input.password!, 'password-change');
    });
    return { success: true };
  }

  async updateProfile(userId: string, body: unknown): Promise<{ success: true }> {
    const input = requiredFields(body, ['name', 'locale']);
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 100)) throw new BadRequestException('Invalid name');
    if (input.locale !== undefined && !this.options.locales.supported.includes(input.locale)) throw new BadRequestException('Invalid locale');
    await this.users().updateUser(userId, input);
    return { success: true };
  }

  async login(body: unknown): Promise<SignInResult> {
    const input = requiredFields(body, ['username', 'password']);
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
    const users = this.users();
    const known = await users.findByUsername(username);
    if (!known?.password) {
      this.dummyHash ??= this.encoder.encode(randomUUID());
      await this.encoder.matches(password, await this.dummyHash);
      return null;
    }
    return users.findByUsernameAndPassword(username, password);
  }

  /**
   * Public sign-in for product login methods (`signInMethods`): the caller has proven the first factor
   * for this enabled account. Same ending as built-in methods: pending deletion → 403, enrolled
   * two-factor → challenge, else a session. Issue the cookie with `AccountSessionCookie`.
   */
  async signIn(user: UserEntity, method: string | SignInMethod): Promise<SignInResult> {
    const resolved: SignInMethod = typeof method === 'string' ? { kind: 'method', name: method } : method;
    if (resolved.kind === 'method' && !this.methodDefinition(resolved.name)) throw new Error(`[back-office/accounts] sign-in method "${resolved.name}" is not registered`);
    if (!user?.status) throw new UnauthorizedException('Account is unavailable');
    return this.completeSignIn(user, resolved);
  }
  private methodDefinition(name: string): { emailProof: boolean } | undefined {
    if (name === EMAIL_CODE_METHOD) return { emailProof: true };
    return Object.hasOwn(this.options.signInMethods, name) ? this.options.signInMethods[name] : undefined;
  }

  /**
   * The one place every interactive sign-in ends (password, OAuth/One Tap, magic link, product methods):
   * refuses an account with a scheduled deletion (403 `ACCOUNT_DELETION_PENDING`), returns a two-factor
   * challenge for enrolled accounts (fails closed with 503 when secrets cannot be read), otherwise opens
   * the session. Callers have already proven the first factor. API keys never pass through here.
   */
  async completeSignIn(user: UserEntity, method: SignInMethod): Promise<SignInResult> {
    await this.assertNoPendingDeletion(user.id);
    if (await this.twoFactorActive(user.id)) {
      if (!this.twoFactor?.available()) throw accountSecurityError(503, E.twoFactorUnavailable, 'Two-factor authentication is not configured on this server');
      return { twoFactorRequired: true, challenge: await this.issueTicket(user, challengePurpose(method), this.options.tickets.twoFactorSeconds) };
    }
    return { twoFactorRequired: false, ...await this.openSession(user, method) };
  }

  /** Enrolment state read straight from the table, so compositions without the service still fail closed. */
  private async twoFactorActive(userId: string, db: DatabaseAdapter = this.db): Promise<boolean> {
    if (!this.options.features.twoFactor) return false;
    const row = await this.model('accountTwoFactor', db).findUnique({ where: { userId }, select: { status: true } }) as { status: string } | null;
    return row?.status === 'active';
  }

  /** 403 `ACCOUNT_DELETION_PENDING` (with `details.executeAfter`) while a deletion is scheduled. */
  async assertNoPendingDeletion(userId: string, db: DatabaseAdapter = this.db): Promise<void> {
    if (!this.options.features.deletion) return;
    const row = await this.model('accountDeletions', db).findUnique({ where: { userId }, select: { status: true, executeAfter: true } }) as
      { status: string; executeAfter: Date } | null;
    if (row?.status === 'scheduled') {
      throw accountSecurityError(403, E.deletionPending, 'This account is scheduled for deletion', { executeAfter: row.executeAfter.toISOString() });
    }
  }
  private async deletionScheduled(userId: string): Promise<boolean> {
    if (!this.options.features.deletion) return false;
    const pending = await this.model('accountDeletions').findUnique({ where: { userId }, select: { status: true } }) as { status: string } | null;
    return pending?.status === 'scheduled';
  }

  /**
   * Account id of a well-formed, unconsumed, unexpired two-factor challenge, or undefined. Only used to
   * key the per-account login budget before the code is checked; `loginTwoFactor` is the authority.
   */
  async twoFactorChallengeSubject(body: unknown): Promise<string | undefined> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const challenge = (body as Record<string, unknown>).challenge;
    if (typeof challenge !== 'string' || !TICKET.test(challenge)) return undefined;
    const ticket = await this.model('accountTickets').findUnique({ where: { tokenHash: ticketHash(challenge) },
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
    const input = requiredFields(body, ['challenge', 'code', 'recoveryCode']);
    const factor = secondFactor(input);
    if (!input.challenge || !TICKET.test(input.challenge)) throw accountSecurityError(400, E.twoFactorChallengeInvalid, 'Invalid or expired sign-in challenge');
    if (!factor) throw accountSecurityError(400, E.twoFactorCodeInvalid, 'Enter a 6-digit code or a recovery code');
    if (!this.twoFactor) throw accountSecurityError(503, E.twoFactorUnavailable, 'Two-factor authentication is not configured on this server');
    const twoFactor = this.twoFactor;
    let signedIn: { user: UserEntity; method: SignInMethod };
    try {
      signedIn = await this.db.$transaction(async tx => {
        const peek = await this.model('accountTickets', tx).findUnique({ where: { tokenHash: ticketHash(input.challenge!) } }) as AccountTicket | null;
        const method = peek && challengeMethod(peek.purpose);
        if (!peek || !method || peek.consumedAt || peek.expiresAt <= this.clock()) throw new OneTimeTicketError('invalid');
        if (!await twoFactor.verify(tx, peek.userId, factor)) {
          throw accountSecurityError(401, E.twoFactorCodeInvalid, 'Invalid code');
        }
        const user = await this.consumeTicket(tx, input.challenge!, peek.purpose);
        return { user, method };
      });
    } catch (error) {
      if (error instanceof OneTimeTicketError) throw accountSecurityError(400, E.twoFactorChallengeInvalid, 'Invalid or expired sign-in challenge');
      throw error;
    }
    await this.assertNoPendingDeletion(signedIn.user.id);
    if (signedIn.method.kind === 'oauth') {
      const binding = await this.model('thirdPartyBinds').findUnique({ where: { id: signedIn.method.bindingId } }) as { userId: string } | null;
      if (binding?.userId !== signedIn.user.id) throw new UnauthorizedException('Provider account is unavailable');
    }
    if (signedIn.method.kind === 'method' && !this.methodDefinition(signedIn.method.name)) throw new UnauthorizedException('Sign-in method is unavailable');
    return this.openSession(signedIn.user, signedIn.method);
  }

  /**
   * "Email me a sign-in link" (account policy `magicLinkEnabled`). Always `{accepted: true}`: a link is
   * mailed in the background only to an existing, enabled account without a scheduled deletion, so the
   * response never reveals whether the address is registered. Never creates an account.
   */
  async requestMagicLink(body: unknown): Promise<{ accepted: true }> {
    const input = requiredFields(body, ['email']);
    const email = emailAddress(input.email);
    if (!(await this.policy()).magicLinkEnabled) throw accountSecurityError(403, E.magicLinkDisabled, 'Sign-in links are turned off');
    this.mailer.assertConfigured();
    const rows = await this.model('users').findMany({ where: { email }, take: 1 }) as UserEntity[];
    const user = rows[0];
    if (user?.status && !user.username.startsWith(DELETED_USERNAME_PREFIX)) {
      this.background('magic-link', async () => {
        if (!await this.deletionScheduled(user.id)) await this.deliverSecret(user, 'magic-link');
      });
    }
    return { accepted: true };
  }

  /** Consumes a mailed sign-in link: the address is now proven (emailVerified), then the normal sign-in ending. */
  async consumeMagicLink(body: unknown): Promise<SignInResult> {
    const input = requiredFields(body, ['ticket']);
    if (!input.ticket || !TICKET.test(input.ticket)) throw new BadRequestException('Invalid ticket');
    if (!(await this.policy()).magicLinkEnabled) throw accountSecurityError(403, E.magicLinkDisabled, 'Sign-in links are turned off');
    let user: UserEntity;
    try {
      user = await this.db.$transaction(async tx => {
        const found = await this.consumeTicket(tx, input.ticket!, 'magic-link');
        if (!found.emailVerified) await this.model('users', tx).update({ where: { id: found.id }, data: { emailVerified: true } });
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
      const checked = await this.users().findByUsernameAndPassword(user.username, password);
      if (!checked || checked.id !== user.id) throw accountSecurityError(403, E.recentAuthenticationFailed, 'The password is not correct');
      return user;
    }
    const session = await this.model('accountSessions').findUnique({ where: { id: sessionId }, select: { createdAt: true } }) as { createdAt: Date } | null;
    if (!session || this.clock().getTime() - session.createdAt.getTime() > RECENT_SESSION_MS) {
      throw accountSecurityError(403, E.recentAuthenticationRequired, 'Sign in again to continue');
    }
    return user;
  }

  private async openSession(user: UserEntity, method: SignInMethod): Promise<SessionPair> {
    const authMethod = method.kind === 'method' ? method.name : method.kind;
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
    const user = await this.users().findById(userId);
    const binding = await this.model('thirdPartyBinds').findUnique({ where: { id: bindingId } }) as { userId: string } | null;
    if (!user?.status || binding?.userId !== userId) throw new UnauthorizedException('Provider account is unavailable');
    return this.completeSignIn(user, { kind: 'oauth', bindingId });
  }

  private async sessionIdentityAllowed(session: AccountSession, user: UserEntity, db = this.db): Promise<boolean> {
    if (!user.status || session.credentialVersion !== Number(user.credentialVersion ?? 0)) return false;
    const method = session.authMethod;
    if (method === 'oauth') {
      if (!session.oauthBindingId) return false;
      const binding = await this.model('thirdPartyBinds', db).findUnique({ where: { id: session.oauthBindingId } }) as { userId: string } | null;
      return binding?.userId === user.id;
    }
    // A magic-link session proved the address when it was opened; an admin e-mail change bumps credentialVersion.
    if (method === 'magic-link') return user.emailVerified === true;
    if (method === undefined || method === null || method === 'password') return this.emailRequirementMet(user);
    const product = this.methodDefinition(method);
    if (!product) return false;
    return product.emailProof ? user.emailVerified === true : this.emailRequirementMet(user);
  }
  /** Password accounts need a verified address only while the policy requires verification. */
  private async emailRequirementMet(user: UserEntity): Promise<boolean> {
    return user.emailVerified === true || !(await this.policy()).requireEmailVerification;
  }

  /** Read the current HttpOnly session without rotating it, for browser-bound OAuth callbacks. */
  async browserSession(token: string): Promise<{ id: string; sid: string }> {
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: this.options.tokens.refreshAudience });
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
   * must not spend the victim session's budget. refresh() remains the authority on rotation and replay.
   */
  async refreshSessionId(token: string): Promise<string | null> {
    if (!token) return null;
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: this.options.tokens.refreshAudience });
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
    const session = await this.model('accountSessions', db).findUnique({ where: { id: sessionId } }) as AccountSession | null;
    const user = await this.users(db).findById(userId);
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date() || !user
      || !await this.sessionIdentityAllowed(session, user, db)) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    return user;
  }
}

function challengePurpose(method: SignInMethod): TwoFactorChallengePurpose {
  switch (method.kind) {
    case 'password': return 'two-factor';
    case 'magic-link': return 'two-factor:magic-link';
    case 'oauth': return `two-factor:oauth:${method.bindingId}`;
    default: return `two-factor:method:${method.name}`;
  }
}
function challengeMethod(purpose: string): SignInMethod | null {
  if (purpose === 'two-factor') return { kind: 'password' };
  if (purpose === 'two-factor:magic-link') return { kind: 'magic-link' };
  const oauth = /^two-factor:oauth:([A-Za-z0-9_-]{1,64})$/.exec(purpose);
  if (oauth) return { kind: 'oauth', bindingId: oauth[1]! };
  const product = /^two-factor:method:([a-z][a-z0-9-]{0,31})$/.exec(purpose);
  return product ? { kind: 'method', name: product[1]! } : null;
}
