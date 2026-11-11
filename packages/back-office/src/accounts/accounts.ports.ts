import type { HttpException } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { UserEntity } from '@zucker-framework/auth';

/** Mailed one-time secrets: a ticket (link, URL fragment) or, in verification mode `'code'`, a six-digit code. */
export type AccountMailPurpose = 'verify-email' | 'reset-password' | 'magic-link';
/** How the secret of `AccountMailer.send` is delivered. Omitted means a ticket (link). */
export interface AccountMailDelivery { kind: 'ticket' | 'code'; expiresInSeconds: number }

/**
 * Account mail port. Implementations render and send in the product's own templates and language;
 * the host never logs secrets. Optional notices are best effort (the host logs and swallows failures).
 */
export interface AccountMailer {
  /** Throws (503) when account mail cannot be sent at all; checked before a secret is issued. */
  assertConfigured(): void;
  send(email: string, purpose: AccountMailPurpose, secret: string, locale: string, userId?: string, delivery?: AccountMailDelivery): Promise<void>;
  /**
   * Six-digit code mail (verification mode `'code'`). When absent, codes go through `send` with
   * `delivery.kind === 'code'`. Throws (503) when the code cannot be delivered.
   */
  code?(email: string, purpose: AccountMailPurpose | 'login', code: string, locale: string, userId?: string, minutes?: number): Promise<void>;
  welcome?(email: string, locale: string, name: string, userId: string): Promise<void>;
  /** Deletion requested: cancel link with a `cancel-deletion` ticket. */
  deletionScheduled?(email: string, locale: string, userId: string, notice: { ticket: string; executeAfter: Date }): Promise<void>;
  /** Deletion executed, to the address captured before anonymisation. Must not retain the address afterwards (delete its own delivery-log row). */
  deletionCompleted?(email: string, locale: string): Promise<void>;
  /** Staff reset the account's two-factor authentication. */
  twoFactorReset?(email: string, locale: string, userId: string): Promise<void>;
}

/** Operator switches the host reads on every request (hot-applied by the product's policy store). */
export interface AccountPolicy {
  registrationOpen: boolean;
  requireEmailVerification: boolean;
  /** New TOTP enrolments allowed; enrolled accounts keep the login step when off. */
  twoFactorEnabled: boolean;
  magicLinkEnabled: boolean;
  deletionEnabled: boolean;
  /** Grace period before a requested deletion is executed (0 = next scan). */
  deletionGraceDays: number;
}
export const DEFAULT_ACCOUNT_POLICY: Readonly<AccountPolicy> = Object.freeze({
  registrationOpen: true, requireEmailVerification: true, twoFactorEnabled: true,
  magicLinkEnabled: false, deletionEnabled: true, deletionGraceDays: 7,
});
export interface AccountPolicySource { policy(): Promise<AccountPolicy> }

/** `password`, `oauth:<provider>`, or a product sign-up method name. */
export type SignupMethod = string;
export interface SignupContext { method: SignupMethod; ip?: unknown; utmSource?: unknown }
/**
 * Product side effects of a new account. `recordSignup` runs inside the user-creation transaction
 * (its writes commit or roll back with the user); `afterSignup` runs after commit with what
 * `recordSignup` returned and must not throw.
 */
export interface AccountSignupHooks {
  recordSignup(tx: DatabaseAdapter, userId: string, context: SignupContext, policy: AccountPolicy): Promise<unknown>;
  afterSignup(userId: string, recorded: unknown): Promise<void>;
}

/** Identity proven by an access token; the guard still checks the session, revocation and credential version. */
export interface AccountAccessIdentity { userId: string; sessionId: string }
/**
 * Additional access-token verifier (for example legacy tokens accepted for their remaining lifetime
 * after a migration). Return null when the token is not of this kind or invalid; never throw for a
 * foreign token. Whatever it returns goes through the same session check as primary tokens.
 */
export interface AccountAccessTokenVerifier { verify(token: string): Promise<AccountAccessIdentity | null> }

/** Fixed, parameterised SQL on the caller's transaction (advisory/row locks, multi-table statements). */
export interface AccountSql {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}
/** Returns the SQL view of a transaction adapter, or null when it has none. */
export type AccountSqlResolver = (tx: DatabaseAdapter) => AccountSql | null;
/** Default resolver: the adapter itself when it has `query(sql, values) → { rows }`. */
export const defaultAccountSql: AccountSqlResolver = tx =>
  typeof (tx as Partial<AccountSql>).query === 'function' ? tx as unknown as AccountSql : null;

/** Key material of TOTP secrets: the encryption key (≥ 32 characters) and the authenticator label. */
export interface AccountTwoFactorKeys {
  encryptionKey?: string;
  /** Values the key must differ from (for example the JWT secret). */
  distinctFrom?: readonly (string | undefined)[];
  issuer?: string;
}

/** Private file storage of avatars (owner-scoped). Errors may be mapped to HTTP by `mapError`. */
export interface AccountAvatarStorage {
  upload(ownerId: string, idempotencyKey: string, file: { originalname: string; buffer: Buffer }): Promise<{ id: string }>;
  read(ownerId: string, assetId: string): Promise<{ body: Buffer }>;
  delete(ownerId: string, assetId: string): Promise<unknown>;
  /** Decode, validate and re-encode an uploaded image as a 256×256 PNG without metadata; throw 400 when unsafe. */
  normalize(bytes: Buffer): Promise<Buffer>;
  mapError?(error: unknown): HttpException | undefined;
}

/** Durable executor of due deletions (a job host). Called once at module init. */
export interface AccountDeletionScheduler {
  start(runner: AccountDeletionRunner): void;
}
export interface AccountDeletionOutcome { executed: boolean; email: string | null; locale: string | null }
export interface AccountDeletionRunner {
  /** Executes one due deletion on the caller's (lease-fenced) transaction. */
  executeInTransaction(tx: DatabaseAdapter, userId: string): Promise<AccountDeletionOutcome>;
  /** Post-commit, best effort: contributors' external cleanup and the completion notice. */
  afterExecution(userId: string, outcome: AccountDeletionOutcome): Promise<void>;
}

/** Product view of the signed-in account added to `GET /authorize/me`. */
export type AccountProfileExtension = (user: UserEntity) => Record<string, unknown>;
