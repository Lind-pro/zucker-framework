import type { InjectionToken, ModuleMetadata, NestInterceptor, Provider, Type } from '@nestjs/common';
import type { PasswordEncoder, UserEntity, VerificationAttemptStore } from '@zucker-framework/auth';
import { resolveModelNames, type ModelNames } from '../shared/models';
import {
  defaultAccountSql, type AccountAccessTokenVerifier, type AccountAvatarStorage, type AccountDeletionScheduler, type AccountMailer,
  type AccountPolicySource, type AccountProfileExtension, type AccountSignupHooks, type AccountSql, type AccountSqlResolver,
  type AccountTwoFactorKeys,
} from './accounts.ports';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { AccountDeletionContributor, AccountDeletionContributorProvider } from './deletion/account-deletion.types';
import type { AccountTwoFactorService } from './two-factor/two-factor.service';
import type { OAuthProviderClient, OAuthSettings } from './oauth/oauth.types';

/** Adapter model names (`DatabaseAdapter.model()`). `users` must also be what `UserService` reads (`'users'`, or an alias). */
export const DEFAULT_ACCOUNTS_MODELS = {
  users: 'users', accountSessions: 'accountSessions', accountTickets: 'accountTickets', accountTwoFactor: 'accountTwoFactor',
  accountRecoveryCodes: 'accountRecoveryCodes', accountDeletions: 'accountDeletions', thirdPartyBinds: 'thirdPartyBinds',
  accountOAuthIntents: 'accountOAuthIntents', accountOAuthProofs: 'accountOAuthProofs', accountApiKeys: 'accountApiKeys',
  accountApiKeyUsage: 'accountApiKeyUsage', accountAvatarChanges: 'accountAvatarChanges', fileAssets: 'fileAssets',
  operationLogs: 'operationLogs', roles: 'roles', userRoles: 'userRoles', menus: 'menus', permissions: 'permissions',
  emailVerifications: 'emailVerifications',
} as const;
export type AccountModelKey = keyof typeof DEFAULT_ACCOUNTS_MODELS;

/** Physical tables of the fixed SQL the host runs (locks, deletion). Always double-quoted in SQL. */
export const DEFAULT_ACCOUNTS_TABLES = {
  users: 'users', accountSessions: 'account_sessions', accountTickets: 'account_tickets', accountTwoFactor: 'account_two_factor',
  accountRecoveryCodes: 'account_recovery_codes', accountDeletions: 'account_deletions', thirdPartyBinds: 'third_party_binds',
  accountOAuthIntents: 'account_oauth_intents', accountOAuthProofs: 'account_oauth_proofs', accountApiKeys: 'account_api_keys',
  accountApiKeyUsage: 'account_api_key_usage', fileAssets: 'file_assets', roles: 'roles', userRoles: 'user_roles',
  // Link tables erased by the built-in deletion contributors; `null` = the deployment has no such table.
  userPermissions: 'user_permissions', userDataPermissions: 'user_data_permissions', dimensionUsers: 'dimension_users',
  userSettings: 'user_settings', notifySubscribers: 'notify_subscribers', userTokens: 'user_tokens',
  userLoginHistory: 'user_login_history', userAcquisition: 'user_acquisition',
} as const;
export type AccountTableKey = keyof typeof DEFAULT_ACCOUNTS_TABLES;
const OPTIONAL_TABLES: ReadonlySet<AccountTableKey> = new Set(['userPermissions', 'userDataPermissions', 'dimensionUsers',
  'userSettings', 'notifySubscribers', 'userTokens', 'userLoginHistory', 'userAcquisition']);
export type AccountTables = Readonly<Record<AccountTableKey, string | null>>;

/**
 * What `POST /authorize/login` (and the password confirmation of deletion cancel) identifies the account by.
 * `'username'`: body `{username, password}`, exact username match (the default, unchanged behaviour).
 * `'email'`: body `{email, password}`, the address trimmed and lower-cased and matched against the stored
 * (normalized) `users.email`. `'username-or-email'`: body `{login, password}`; an exact username match wins,
 * otherwise a value containing `@` is matched as an address.
 */
export type AccountLoginIdentifier = 'username' | 'email' | 'username-or-email';
/** Request-body field of each identifier option. */
export const ACCOUNT_LOGIN_IDENTIFIER_FIELDS: Readonly<Record<AccountLoginIdentifier, 'username' | 'email' | 'login'>> = Object.freeze({
  username: 'username', email: 'email', 'username-or-email': 'login',
});

export type AccountFeatureName = 'register' | 'magicLink' | 'twoFactor' | 'deletion' | 'avatar' | 'apiKeys' | 'oauth';
/** `mount: false` = the feature is part of the deployment (the core honours it) but its routes are composed elsewhere. */
interface Mountable { mount?: boolean; imports?: ModuleMetadata['imports']; providers?: Provider[] }
export interface AccountTwoFactorFeature extends Mountable {
  keys?: AccountTwoFactorKeys;
  /** Implementation class (a subclass that sources its keys differently). */
  service?: Type<AccountTwoFactorService>;
}
export interface AccountDeletionFeature extends Mountable {
  contributors?: readonly (AccountDeletionContributor | AccountDeletionContributorProvider)[];
  scheduler?: Type<AccountDeletionScheduler>;
  /** Product refusals checked at scheduling and again before execution (throw `accountSecurityError(409, …)`). */
  assertDeletable?: (tx: DatabaseAdapter, sql: AccountSql, userId: string, now: Date) => Promise<void>;
  /** Extra `users` fields cleared at anonymisation (product columns such as an avatar id or device data). */
  clearUserFields?: Readonly<Record<string, unknown>>;
}
export interface AccountApiKeysFeature extends Mountable {
  /** Scopes a key may carry (`account:read` admits `GET /v1/account`). */
  scopes?: readonly string[];
  /** Scopes of a key created without `scopes`. */
  defaultScopes?: readonly string[];
  expiryDays?: readonly number[];
  keyPrefix?: string;
  /** Requests per minute per key (rate limiter `api-key`). */
  rateLimit?: number;
}
export interface AccountOAuthFeature extends Mountable {
  googleOneTap?: boolean;
  googleRedirect?: boolean;
  github?: boolean;
  /** Settings (value or class); omit to provide `ACCOUNTS_OAUTH_SETTINGS` yourself (e.g. a hot view). */
  settings?: OAuthSettings | Type<OAuthSettings>;
  providerClient?: Type<OAuthProviderClient>;
  /** Allowed post-login paths (exact) and prefixes; anything else becomes `defaultPath`. */
  returnPaths?: { defaultPath?: string; linkPath?: string; exact?: readonly string[]; prefixes?: readonly string[] };
  /** Browser-visible callback path (behind any proxy prefix). */
  callbackPath?: (provider: string) => string;
  /** Web page that finishes the flow (`#ticket=…` / `?error=`). */
  completionPath?: (locale: string) => string;
  browserCookie?: { name?: string; path?: string };
}
export interface AccountAvatarFeature extends Mountable {
  storage?: Type<AccountAvatarStorage>;
  upload?: Type<NestInterceptor>;
}

/** A port provided elsewhere (imported or global module), aliased by token. */
export interface AccountPortRef {
  useExisting: InjectionToken;
}

export interface BackOfficeAccountsOptions {
  models?: Partial<Record<AccountModelKey, string>>;
  tables?: Partial<Record<AccountTableKey, string | null>>;
  tokens?: {
    accessTtlSeconds?: number;
    refreshTtlSeconds?: number;
    accessAudience?: string;
    refreshAudience?: string;
    /** Extra access-token claims (`sub`, `sid`, `tokenUse`, `aud`, `exp`, `iat`, `jti` cannot be set). Default `{ username }`. */
    extraClaims?: (user: UserEntity) => Record<string, unknown>;
    /** Tried in order when the primary verification fails; still session-checked. */
    additionalAccessVerifiers?: ReadonlyArray<Type<AccountAccessTokenVerifier> | AccountAccessTokenVerifier>;
  };
  tickets?: { mailSeconds?: number; magicLinkSeconds?: number; twoFactorSeconds?: number };
  /** Password scheme of stored hashes (default bcrypt). Also used for the dummy hash of unknown usernames. */
  passwordEncoder?: PasswordEncoder | Type<PasswordEncoder>;
  verification?: {
    /** `'ticket'` (link in the URL fragment, default) or `'code'` (six digits, `email` + `code` in the body). */
    mode?: 'ticket' | 'code';
    codeExpirySeconds?: number;
    resendSeconds?: number;
    /** Failed-attempt lockout store for codes (required in code mode; e.g. `CacheVerificationAttemptStore`). */
    attempts?: Type<VerificationAttemptStore> | VerificationAttemptStore;
    /** Field names of the code model (`emailVerifications`). */
    fields?: { subject?: string; purpose?: string };
    /** `verify-email` also opens a session (cookie) once the address is proven. */
    signInOnVerify?: boolean;
  };
  /**
   * Account mail port: a class (registered here), an instance, or `{ useExisting: token }` for a mailer
   * provided by an imported/global module (e.g. `MAIL_ACCOUNT_MAILER` of `@zucker-framework/back-office/mail`).
   */
  mailer?: Type<AccountMailer> | AccountMailer | AccountPortRef;
  policy?: Type<AccountPolicySource> | AccountPolicySource;
  signupHooks?: Type<AccountSignupHooks>;
  /** Password sign-in identifier (default `{ identifier: 'username' }`). */
  login?: { identifier?: AccountLoginIdentifier };
  /**
   * Values of accounts the host creates (`POST /authorize/register`, OAuth sign-up). `typeId` defaults to
   * `'member'`; product sign-up paths can read the resolved value from `AccountService.options.signup`.
   */
  signup?: { typeId?: string };
  /** Refresh cookie. `secure` may be a function read at construction. */
  cookie?: { name?: string; path?: string; sameSite?: 'lax' | 'strict' | 'none'; secure?: boolean | (() => boolean); domain?: string };
  /** Trusted `Origin` values of browser mutations (exact match); a function is read at construction. Default: none. */
  origins?: readonly string[] | (() => Iterable<string>);
  locales?: { supported?: readonly string[]; default?: string };
  /** Product sign-in methods for `AccountService.signIn(user, name)`; `emailProof` = the method proves the address. */
  signInMethods?: Readonly<Record<string, { emailProof: boolean }>>;
  /** Extra fields of `GET /authorize/me`. */
  profile?: AccountProfileExtension;
  sql?: AccountSqlResolver;
  /** Modules the port classes need (mailer, policy, hooks, verifiers). */
  imports?: ModuleMetadata['imports'];
  features?: {
    register?: boolean;
    magicLink?: boolean;
    twoFactor?: boolean | AccountTwoFactorFeature;
    deletion?: boolean | AccountDeletionFeature;
    avatar?: boolean | AccountAvatarFeature;
    apiKeys?: boolean | AccountApiKeysFeature;
    oauth?: boolean | AccountOAuthFeature;
  };
}

export interface ResolvedAccountsFeatures {
  register: boolean;
  magicLink: boolean;
  twoFactor: (AccountTwoFactorFeature & { mount: boolean }) | null;
  deletion: (AccountDeletionFeature & { mount: boolean }) | null;
  avatar: (AccountAvatarFeature & { mount: boolean }) | null;
  apiKeys: (Required<Pick<AccountApiKeysFeature, 'scopes' | 'defaultScopes' | 'expiryDays' | 'keyPrefix' | 'rateLimit'>> & AccountApiKeysFeature & { mount: boolean }) | null;
  oauth: (Required<Pick<AccountOAuthFeature, 'googleOneTap' | 'googleRedirect' | 'github' | 'callbackPath' | 'completionPath'>> & AccountOAuthFeature & {
    mount: boolean; returnPaths: Required<NonNullable<AccountOAuthFeature['returnPaths']>>; browserCookie: { name: string; path: string };
  }) | null;
}

export interface ResolvedAccountsOptions {
  readonly models: ModelNames<AccountModelKey>;
  readonly tables: AccountTables;
  readonly tokens: {
    readonly accessTtlSeconds: number; readonly refreshTtlSeconds: number;
    readonly accessAudience: string; readonly refreshAudience: string;
    readonly extraClaims: (user: UserEntity) => Record<string, unknown>;
    readonly additionalAccessVerifiers: ReadonlyArray<Type<AccountAccessTokenVerifier> | AccountAccessTokenVerifier>;
  };
  readonly tickets: { readonly mailSeconds: number; readonly magicLinkSeconds: number; readonly twoFactorSeconds: number };
  readonly passwordEncoder?: PasswordEncoder | Type<PasswordEncoder>;
  readonly verification: {
    readonly mode: 'ticket' | 'code'; readonly codeExpirySeconds: number; readonly resendSeconds: number;
    readonly attempts?: Type<VerificationAttemptStore> | VerificationAttemptStore;
    readonly fields: { readonly subject: string; readonly purpose: string };
    readonly signInOnVerify: boolean;
  };
  readonly mailer?: Type<AccountMailer> | AccountMailer | AccountPortRef;
  readonly policy?: Type<AccountPolicySource> | AccountPolicySource;
  readonly signupHooks?: Type<AccountSignupHooks>;
  readonly login: { readonly identifier: AccountLoginIdentifier; readonly field: 'username' | 'email' | 'login' };
  readonly signup: { readonly typeId: string };
  readonly cookie: { readonly name: string; readonly path: string; readonly sameSite: 'lax' | 'strict' | 'none'; readonly secure: boolean | (() => boolean); readonly domain?: string };
  readonly origins: readonly string[] | (() => Iterable<string>);
  readonly locales: { readonly supported: readonly string[]; readonly default: string };
  readonly signInMethods: Readonly<Record<string, { emailProof: boolean }>>;
  readonly profile?: AccountProfileExtension;
  readonly sql: AccountSqlResolver;
  readonly imports: NonNullable<ModuleMetadata['imports']>;
  readonly features: Readonly<ResolvedAccountsFeatures>;
}

const fail = (message: string): never => { throw new TypeError(`[back-office/accounts] ${message}`); };
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_METHODS = new Set(['password', 'oauth', 'magic-link']);
const RESERVED_CLAIMS = new Set(['sub', 'sid', 'tokenUse', 'aud', 'exp', 'iat', 'nbf', 'jti', 'iss']);

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value as number;
}
function text(value: unknown, fallback: string, name: string, pattern = /^[\x21-\x7e]{1,128}$/): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${name} is invalid`);
  return value as string;
}
function feature<T extends object>(value: boolean | T | undefined, fallback: boolean): (T & { mount: boolean }) | null {
  if (value === undefined) value = fallback;
  if (value === false) return null;
  if (value === true) return { mount: true } as T & { mount: boolean };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('features must be booleans or option objects');
  const mount = (value as Mountable).mount;
  if (mount !== undefined && typeof mount !== 'boolean') fail('features.*.mount must be a boolean');
  return { ...value, mount: mount ?? true };
}
function stringList(value: unknown, fallback: readonly string[], name: string, pattern: RegExp): readonly string[] {
  if (value === undefined) return Object.freeze([...fallback]);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !pattern.test(item))) fail(`${name} must be a list of valid strings`);
  return Object.freeze([...new Set(value as string[])]);
}

function resolveTables(overrides: BackOfficeAccountsOptions['tables']): AccountTables {
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) fail('tables must be an object');
  const tables: Record<string, string | null> = { ...DEFAULT_ACCOUNTS_TABLES };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(DEFAULT_ACCOUNTS_TABLES, key)) fail(`unknown table key "${key}"`);
    if (value === undefined) continue;
    if (value === null) {
      if (!OPTIONAL_TABLES.has(key as AccountTableKey)) fail(`table "${key}" is required`);
      tables[key] = null; continue;
    }
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`table "${key}" must be an identifier`);
    tables[key] = value;
  }
  return Object.freeze(tables) as AccountTables;
}

/** Validates, applies defaults and freezes. Called by `forRoot`, so misconfiguration fails at startup. */
export function resolveAccountsOptions(input: BackOfficeAccountsOptions = {}): ResolvedAccountsOptions {
  if (!input || typeof input !== 'object') fail('options must be an object');
  const tokens = input.tokens ?? {};
  const extraClaims = tokens.extraClaims ?? ((user: UserEntity) => ({ username: user.username }));
  if (typeof extraClaims !== 'function') fail('tokens.extraClaims must be a function');
  const verifiers = tokens.additionalAccessVerifiers ?? [];
  if (!Array.isArray(verifiers) || verifiers.some(entry => typeof entry !== 'function' && typeof (entry as AccountAccessTokenVerifier)?.verify !== 'function')) {
    fail('tokens.additionalAccessVerifiers must be verifier classes or objects with verify()');
  }
  const verification = input.verification ?? {};
  const mode = verification.mode ?? 'ticket';
  if (mode !== 'ticket' && mode !== 'code') fail('verification.mode must be "ticket" or "code"');
  if (mode === 'code' && !verification.attempts) fail('verification.attempts is required in code mode (failed-code lockout store)');
  const cookie = input.cookie ?? {};
  const sameSite = cookie.sameSite ?? 'lax';
  if (!['lax', 'strict', 'none'].includes(sameSite)) fail('cookie.sameSite must be lax, strict or none');
  if (sameSite === 'none' && cookie.secure === false) fail('cookie.sameSite "none" requires a secure cookie');
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean' && typeof cookie.secure !== 'function') fail('cookie.secure must be a boolean or function');
  const origins = input.origins ?? [];
  if (typeof origins !== 'function') stringList(origins, [], 'origins', /^https?:\/\/[^\s/]+$/);
  const supported = stringList(input.locales?.supported, ['en', 'zh'], 'locales.supported', /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/);
  if (!supported.length) fail('locales.supported must not be empty');
  const defaultLocale = input.locales?.default ?? supported[0]!;
  if (!supported.includes(defaultLocale)) fail('locales.default must be one of locales.supported');
  const methods = input.signInMethods ?? {};
  for (const [name, method] of Object.entries(methods)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || RESERVED_METHODS.has(name)) fail(`sign-in method "${name}" is invalid or reserved`);
    if (!method || typeof method.emailProof !== 'boolean') fail(`sign-in method "${name}" needs emailProof`);
  }
  if (input.login !== undefined && (!input.login || typeof input.login !== 'object' || Array.isArray(input.login))) fail('login must be an object');
  const identifier = input.login?.identifier ?? 'username';
  if (!Object.hasOwn(ACCOUNT_LOGIN_IDENTIFIER_FIELDS, identifier)) fail('login.identifier must be "username", "email" or "username-or-email"');
  if (input.signup !== undefined && (!input.signup || typeof input.signup !== 'object' || Array.isArray(input.signup))) fail('signup must be an object');
  const typeId = text(input.signup?.typeId, 'member', 'signup.typeId', /^[A-Za-z0-9_.:-]{1,64}$/);
  const features = input.features ?? {};
  const apiKeys = feature(features.apiKeys, false);
  const oauth = feature(features.oauth, false);
  const resolvedApiKeys = apiKeys && {
    ...apiKeys,
    scopes: stringList(apiKeys.scopes, ['account:read'], 'features.apiKeys.scopes', /^[a-z][a-z0-9:_-]{0,63}$/),
    defaultScopes: stringList(apiKeys.defaultScopes, ['account:read'], 'features.apiKeys.defaultScopes', /^[a-z][a-z0-9:_-]{0,63}$/),
    expiryDays: Object.freeze([...(apiKeys.expiryDays ?? [7, 30, 90, 365])]),
    keyPrefix: text(apiKeys.keyPrefix, 'zk_api_', 'features.apiKeys.keyPrefix', /^[a-z][a-z0-9_]{1,15}$/),
    rateLimit: positiveInteger(apiKeys.rateLimit, 60, 'features.apiKeys.rateLimit'),
  };
  if (resolvedApiKeys && resolvedApiKeys.defaultScopes.some(scope => !resolvedApiKeys.scopes.includes(scope))) fail('features.apiKeys.defaultScopes must be allowed scopes');
  if (resolvedApiKeys && resolvedApiKeys.expiryDays.some(days => !Number.isSafeInteger(days) || days < 1 || days > 3650)) fail('features.apiKeys.expiryDays must be 1–3650');
  const returnPaths = oauth?.returnPaths ?? {};
  const resolvedOAuth = oauth && {
    ...oauth,
    googleOneTap: oauth.googleOneTap ?? true, googleRedirect: oauth.googleRedirect ?? true, github: oauth.github ?? true,
    callbackPath: oauth.callbackPath ?? ((provider: string) => `/api/authorize/oauth/${provider}/callback`),
    completionPath: oauth.completionPath ?? ((locale: string) => `/${locale}/oauth/callback`),
    returnPaths: Object.freeze({ defaultPath: returnPaths.defaultPath ?? '/dashboard', linkPath: returnPaths.linkPath ?? '/account',
      exact: Object.freeze([...(returnPaths.exact ?? ['/account', '/dashboard'])]), prefixes: Object.freeze([...(returnPaths.prefixes ?? [])]) }),
    browserCookie: Object.freeze({ name: oauth.browserCookie?.name ?? 'zucker-oauth-browser', path: oauth.browserCookie?.path ?? '/api/authorize/oauth' }),
  };
  for (const path of resolvedOAuth ? [resolvedOAuth.returnPaths.defaultPath, resolvedOAuth.returnPaths.linkPath, ...resolvedOAuth.returnPaths.exact, ...resolvedOAuth.returnPaths.prefixes] : []) {
    if (typeof path !== 'string' || !/^\/(?!\/)[^\s\\]*$/.test(path)) fail('features.oauth.returnPaths entries must be local absolute paths');
  }
  const accessAudience = text(tokens.accessAudience, 'zucker:access', 'tokens.accessAudience');
  const refreshAudience = text(tokens.refreshAudience, 'zucker:refresh', 'tokens.refreshAudience');
  if (accessAudience === refreshAudience) fail('access and refresh audiences must differ');
  const resolved: ResolvedAccountsOptions = {
    models: resolveModelNames('accounts', DEFAULT_ACCOUNTS_MODELS, input.models),
    tables: resolveTables(input.tables),
    tokens: Object.freeze({
      accessTtlSeconds: positiveInteger(tokens.accessTtlSeconds, 900, 'tokens.accessTtlSeconds'),
      refreshTtlSeconds: positiveInteger(tokens.refreshTtlSeconds, 30 * 86400, 'tokens.refreshTtlSeconds'),
      accessAudience, refreshAudience,
      extraClaims: (user: UserEntity) => Object.fromEntries(Object.entries(extraClaims(user) ?? {}).filter(([key]) => !RESERVED_CLAIMS.has(key))),
      additionalAccessVerifiers: Object.freeze([...verifiers]),
    }),
    tickets: Object.freeze({
      mailSeconds: positiveInteger(input.tickets?.mailSeconds, 1800, 'tickets.mailSeconds'),
      magicLinkSeconds: positiveInteger(input.tickets?.magicLinkSeconds, 900, 'tickets.magicLinkSeconds'),
      twoFactorSeconds: positiveInteger(input.tickets?.twoFactorSeconds, 300, 'tickets.twoFactorSeconds'),
    }),
    passwordEncoder: input.passwordEncoder,
    verification: Object.freeze({
      mode, codeExpirySeconds: positiveInteger(verification.codeExpirySeconds, 900, 'verification.codeExpirySeconds'),
      resendSeconds: positiveInteger(verification.resendSeconds, 60, 'verification.resendSeconds'),
      attempts: verification.attempts,
      fields: Object.freeze({ subject: text(verification.fields?.subject, 'email', 'verification.fields.subject', IDENTIFIER),
        purpose: text(verification.fields?.purpose, 'purpose', 'verification.fields.purpose', IDENTIFIER) }),
      signInOnVerify: verification.signInOnVerify ?? false,
    }),
    mailer: input.mailer, policy: input.policy, signupHooks: input.signupHooks,
    login: Object.freeze({ identifier, field: ACCOUNT_LOGIN_IDENTIFIER_FIELDS[identifier] }),
    signup: Object.freeze({ typeId }),
    cookie: Object.freeze({ name: text(cookie.name, 'zucker-session', 'cookie.name', /^[A-Za-z0-9_-]{1,64}$/),
      path: text(cookie.path, '/', 'cookie.path', /^\/[\x21-\x7e]{0,127}$/), sameSite, secure: cookie.secure ?? true,
      ...(cookie.domain ? { domain: text(cookie.domain, '', 'cookie.domain', /^[A-Za-z0-9.-]{1,253}$/) } : {}) }),
    origins: typeof origins === 'function' ? origins : Object.freeze([...origins]),
    locales: Object.freeze({ supported, default: defaultLocale }),
    signInMethods: Object.freeze({ ...methods }),
    profile: input.profile,
    sql: input.sql ?? defaultAccountSql,
    imports: [...(input.imports ?? [])],
    features: Object.freeze({
      register: features.register ?? true,
      magicLink: features.magicLink ?? true,
      twoFactor: feature(features.twoFactor, true),
      deletion: feature(features.deletion, false),
      avatar: feature(features.avatar, false),
      apiKeys: resolvedApiKeys as ResolvedAccountsFeatures['apiKeys'],
      oauth: resolvedOAuth as ResolvedAccountsFeatures['oauth'],
    }),
  };
  return Object.freeze(resolved);
}

/** Current trusted origins (a function option is read at each call). */
export function accountOrigins(options: ResolvedAccountsOptions): ReadonlySet<string> {
  return new Set(typeof options.origins === 'function' ? [...options.origins()].map(value => value.trim()) : options.origins);
}
export function cookieSecure(options: ResolvedAccountsOptions): boolean {
  return typeof options.cookie.secure === 'function' ? options.cookie.secure() : options.cookie.secure;
}
/** PostgreSQL reserved key words (SQL:2016 "reserved" + "reserved (can be function or type)"). */
const RESERVED_SQL_WORDS = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column '
  + 'concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default '
  + 'deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is '
  + 'isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary '
  + 'references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using '
  + 'variadic verbose when where window with').split(' '));
/**
 * SQL identifier of a resolved (validated) table name: plain lower-case non-keyword names are emitted as
 * is (identical to their quoted form in PostgreSQL), anything else double-quoted.
 */
export function table(options: ResolvedAccountsOptions, key: AccountTableKey): string {
  const name = options.tables[key];
  if (!name) throw new Error(`[back-office/accounts] table "${key}" is not configured`);
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED_SQL_WORDS.has(name) ? name : `"${name}"`;
}
export function requireSql(options: ResolvedAccountsOptions, tx: DatabaseAdapter, purpose: string): AccountSql {
  const sql = options.sql(tx);
  if (!sql) throw new Error(`[back-office/accounts] ${purpose} needs a transaction adapter with query(sql, values) (option "sql")`);
  return sql;
}
/** Locale of a request field: a supported value or the default. */
export function accountLocale(options: ResolvedAccountsOptions, value: unknown): string {
  return typeof value === 'string' && options.locales.supported.includes(value) ? value : options.locales.default;
}
