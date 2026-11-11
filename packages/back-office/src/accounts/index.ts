// Public surface of `@zucker-framework/back-office/accounts` (work package F2).
export { BackOfficeAccountsModule, deletionContributorProviders } from './accounts.module';
export {
  DEFAULT_ACCOUNTS_MODELS, DEFAULT_ACCOUNTS_TABLES, ACCOUNT_LOGIN_IDENTIFIER_FIELDS, resolveAccountsOptions, accountOrigins, accountLocale, cookieSecure, requireSql, table as accountTable,
  type AccountModelKey, type AccountTableKey, type AccountTables, type AccountFeatureName, type AccountPortRef, type BackOfficeAccountsOptions, type ResolvedAccountsOptions,
  type ResolvedAccountsFeatures, type AccountTwoFactorFeature, type AccountDeletionFeature, type AccountApiKeysFeature, type AccountOAuthFeature,
  type AccountAvatarFeature, type AccountLoginIdentifier,
} from './accounts.options';
export {
  ACCOUNTS_OPTIONS, ACCOUNTS_MAILER, ACCOUNTS_CLOCK, ACCOUNTS_POLICY, ACCOUNTS_SIGNUP_HOOKS, ACCOUNTS_PASSWORD_ENCODER, ACCOUNTS_ACCESS_VERIFIERS,
  ACCOUNTS_VERIFICATION_ATTEMPTS, ACCOUNTS_TWO_FACTOR_KEYS, ACCOUNTS_API_KEY_AUTHENTICATOR, ACCOUNTS_OAUTH_SETTINGS, ACCOUNTS_OAUTH_PROVIDER_CLIENT,
  ACCOUNTS_DELETION_CONTRIBUTORS, ACCOUNTS_DELETION_SCHEDULER, ACCOUNTS_AVATAR_STORAGE, ACCOUNTS_AVATAR_UPLOAD,
} from './accounts.tokens';
export {
  DEFAULT_ACCOUNT_POLICY, defaultAccountSql,
  type AccountMailPurpose, type AccountMailDelivery, type AccountMailer, type AccountPolicy, type AccountPolicySource, type SignupMethod, type SignupContext,
  type AccountSignupHooks, type AccountAccessIdentity, type AccountAccessTokenVerifier, type AccountSql, type AccountSqlResolver, type AccountTwoFactorKeys,
  type AccountAvatarStorage, type AccountDeletionScheduler, type AccountDeletionOutcome, type AccountDeletionRunner, type AccountProfileExtension,
} from './accounts.ports';
export {
  ACCOUNT_SECURITY_ERRORS, accountSecurityError, systemAccountSecurityClock, RECENT_SESSION_MS, assertAccountOrigin, stringFields, requiredFields,
  spendBudgets, emailAddress, type AccountSecurityErrorCode, type AccountSecurityClock, type AccountRequest,
} from './account-security';
export {
  ACCOUNTS_LIMITER, SESSION_REFRESH_LIMITER, SESSION_REFRESH_NETWORK_LIMITER, SESSION_READ_LIMITER, LOGIN_LIMITER, LOGIN_ACCOUNT_LIMITER,
  TWO_FACTOR_LIMITER, ACCOUNT_SECURITY_ADMIN_LIMITER, API_KEY_LIMITER, API_DEFAULT_LIMITER, loginAccountKey, composeRateLimiters,
  ACCOUNT_RATE_LIMITS, ACCOUNT_SECURITY_RATE_LIMITS, ACCOUNT_API_KEY_RATE_LIMITS, type RateLimiterFragment,
} from './rate-limits';
export {
  AccountService, DELETED_USERNAME_PREFIX, EMAIL_CODE_METHOD,
  type RegisterResult, type RegisterRequestContext, type TwoFactorChallengePurpose, type AccountTicketPurpose, type AccountTicket, type AccountSession,
  type SignInMethod, type SessionPair, type SignInResult, type ConsumeEmailResult,
} from './account.service';
export { AccountSessionCookie, type AccountSessionBody, type AccountSignInBody } from './account-session-cookie';
export { AccountController, createAccountController, type AccountControllerConfig } from './account.controller';
export { AccountGuard, ACCOUNT_API_KEY_SCOPES, AccountApiKeyScopes } from './account.guard';
export { AccountSessionAdminHooks } from './admin-user-hooks';
export {
  AccountTwoFactorService, secondFactor, twoFactorCipher, TOTP_PERIOD_SECONDS, TOTP_WINDOW, RECOVERY_CODE_COUNT,
  type SecondFactor, type TwoFactorRow, type TwoFactorStatus,
} from './two-factor/two-factor.service';
export { AccountTwoFactorController, AccountTwoFactorAdminController } from './two-factor/two-factor.controller';
export { OAuthService } from './oauth/oauth.service';
export { OAuthController } from './oauth/oauth.controller';
export { ConfiguredOAuthProviderClient } from './oauth/oauth-provider';
export type {
  OAuthProvider, OAuthSettings, OAuthCodeInput, OAuthProviderClient, OAuthIntent, OAuthHandoff, OAuthRequestContext, BindingRecord,
} from './oauth/oauth.types';
export { AccountApiKeysService, AccountApiKeyAuthenticator, ACCOUNT_API_KEY_SERVICE_PROVIDER } from './api-keys/api-keys.service';
export { AccountApiKeysController, ApiKeyAccountController } from './api-keys/api-keys.controller';
export { AccountDeletionService } from './deletion/account-deletion.service';
export { AccountDeletionController } from './deletion/account-deletion.controller';
export { accountDeletionContributors } from './deletion/account-deletion.contributors';
export {
  AccountDeletionPostponedError, orderContributors, type AccountDeletionContributor, type AccountDeletionContributorProvider,
} from './deletion/account-deletion.types';
export { AccountAvatarService, avatarCommand, AVATAR_MAX_INPUT_BYTES, type AvatarCommand, type AvatarSnapshot, type UploadedAvatarFile } from './avatar/avatar.service';
export { AccountAvatarController, AccountAvatarUploadInterceptor } from './avatar/avatar.controller';
export {
  syncMenus, syncPermissions, seedStarterData, createAdministrator, assignRoleByEmail, assignRole, parseRoleExpiry, parseAssignRoleArguments, AssignRoleError,
  type MenuCatalogEntry, type MenuSyncOptions, type PermissionCatalogEntry, type SyncResult, type StarterDataSeed, type CreateAdministratorOptions,
  type AssignRoleInput, type AssignRoleResult,
} from './bootstrap';
