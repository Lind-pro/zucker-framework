import { backOfficeToken } from '../shared/tokens';

/** Resolved, frozen `BackOfficeAccountsOptions` (`resolveAccountsOptions`). */
export const ACCOUNTS_OPTIONS = backOfficeToken('accounts', 'options');
/** `AccountMailer` port (account mail: tickets/codes, welcome, deletion and two-factor notices). */
export const ACCOUNTS_MAILER = backOfficeToken('accounts', 'mailer');
/** `AccountSecurityClock` (`() => Date`) of tickets, TOTP steps, recent authentication and deletion grace. */
export const ACCOUNTS_CLOCK = backOfficeToken('accounts', 'clock');
/** `AccountPolicySource` port (registration, verification, 2FA, magic link and deletion switches). */
export const ACCOUNTS_POLICY = backOfficeToken('accounts', 'policy');
/** `AccountSignupHooks` port (acquisition rows, initial role, welcome credits…), optional. */
export const ACCOUNTS_SIGNUP_HOOKS = backOfficeToken('accounts', 'signupHooks');
/** `PasswordEncoder` used for every account password, including the dummy hash of unknown usernames. */
export const ACCOUNTS_PASSWORD_ENCODER = backOfficeToken('accounts', 'passwordEncoder');
/** Additional access-token verifiers (`AccountAccessTokenVerifier[]`), e.g. legacy tokens during a migration. */
export const ACCOUNTS_ACCESS_VERIFIERS = backOfficeToken('accounts', 'accessVerifiers');
/** `VerificationAttemptStore` of six-digit codes (verification mode `'code'`). */
export const ACCOUNTS_VERIFICATION_ATTEMPTS = backOfficeToken('accounts', 'verificationAttempts');
/** Key material of TOTP secrets (`AccountTwoFactorKeys`). */
export const ACCOUNTS_TWO_FACTOR_KEYS = backOfficeToken('accounts', 'twoFactorKeys');
/** `CanActivate` that authenticates `@AccountApiKeyScopes(...)` routes with an API key instead of a session. */
export const ACCOUNTS_API_KEY_AUTHENTICATOR = backOfficeToken('accounts', 'apiKeyAuthenticator');
/** `OAuthSettings` (may be a live view over a hot configuration). */
export const ACCOUNTS_OAUTH_SETTINGS = backOfficeToken('accounts', 'oauthSettings');
/** `OAuthProviderClient` (code exchange + Google One Tap verification). */
export const ACCOUNTS_OAUTH_PROVIDER_CLIENT = backOfficeToken('accounts', 'oauthProviderClient');
/** Ordered `AccountDeletionContributor[]`. */
export const ACCOUNTS_DELETION_CONTRIBUTORS = backOfficeToken('accounts', 'deletionContributors');
/** Optional `AccountDeletionScheduler` (durable execution of due deletions). */
export const ACCOUNTS_DELETION_SCHEDULER = backOfficeToken('accounts', 'deletionScheduler');
/** `AccountAvatarStorage` port (private file storage of avatars). */
export const ACCOUNTS_AVATAR_STORAGE = backOfficeToken('accounts', 'avatarStorage');
/** `NestInterceptor` that parses the multipart `file` field of avatar uploads (e.g. `FileInterceptor('file', …)`). */
export const ACCOUNTS_AVATAR_UPLOAD = backOfficeToken('accounts', 'avatarUpload');
