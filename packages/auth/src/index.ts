// Interfaces & types
export type {
  Permission,
  Role,
  RoleTreeNode,
  DimensionType,
  Dimension,
  DimensionProvider,
  TokenInfo,
  AuthUser,
  Authentication,
  ZuckerAuthModuleOptions,
  AuthenticationPredicate,
  SettingValueHolder,
} from './interfaces';
export {
  TokenState,
  AllopatricLoginMode,
  DIMENSION_PROVIDERS,
  SimplePermission,
  PermissionActions,
  DataAccessConfigDefaultType,
  DefaultDimensionType,
  SimpleDimensionType,
  SimpleDimension,
  AuthenticationPredicates,
  createAuthenticationPredicate,
  UserSettingPermission,
  NullSettingValueHolder,
  createSettingValueHolder,
  TokenInfoUtils,
} from './interfaces';

// Data Access Control
export type {
  DataAccessConfig,
  OwnCreatedDataAccessConfig,
  FieldFilterDataAccessConfig,
  ScopeDataAccessConfig,
  DimensionDataAccessConfig,
  DataAccessType,
  DataAccessHandler,
  AuthorizingContext,
  DataAccessResult,
  Term,
} from './data-access';
export {
  DefaultDataAccessType,
  ownCreatedConfig,
  fieldFilterConfig,
  scopeConfig,
  dimensionConfig,
  DATA_ACCESS_HANDLERS,
  allowResult,
  denyResult,
  filterResult,
  mergeResults,
  OwnCreatedDataAccessHandler,
  FieldFilterDataAccessHandler,
  ScopeDataAccessHandler,
  DimensionDataAccessHandler,
} from './data-access';

// Authentication
export type { AuthenticationSupplier, SupplierContext } from './authentication';
export {
  AUTHENTICATION_SUPPLIERS,
  DefaultAuthentication,
  fromJwtUser,
  AuthenticationHolder,
} from './authentication';

// Decorators
export {
  Public,
  Permissions,
  RequirePermissions,
  Resource,
  Action,
  QueryAction,
  CreateAction,
  SaveAction,
  DeleteAction,
  UpdateAction,
  ResourceAction,
  CurrentUser,
  DataPermission,
  SkipDataPermission,
  TwoFactor,
  Authorize,
  DimensionCheck,
  RequiresRoles,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
  AUTHORIZE_KEY,
  DATA_PERMISSION_KEY,
  TWO_FACTOR_KEY,
  DIMENSION_KEY,
} from './decorators';
export type {
  ResourceOptions,
  ActionOptions,
  AuthorizeResourceOptions,
  DataPermissionOptions,
  TwoFactorOptions,
  AuthorizeOptions,
  ResolvedAuthorizeOptions,
  AuthorizeLogical,
  AuthorizePhased,
  DimensionOptions,
  RequiresRolesOptions,
} from './decorators';

// Guards
export { JwtAuthGuard } from './guards/jwt-auth.guard';
export { PermissionsGuard } from './guards/permissions.guard';
export {
  DataPermissionGuard,
  DATABASE_ADAPTER,
  DATA_ACCESS_RESULT_KEY,
} from './guards/data-permission.guard';
export { TwoFactorGuard } from './guards/two-factor.guard';

// Services
export { PermissionService } from './services/permission.service';
export { PermissionScannerService } from './services/permission-scanner.service';
export type { ScannedPermission } from './services/permission-scanner.service';
export { DimensionService } from './services/dimension.service';
export { RoleHierarchyService } from './services/role-hierarchy.service';
export {
  TokenService,
  TOKEN_CACHE,
  SESSION_TRACKED_CLAIM,
  REVOCATION_WATERMARK_CLAIM,
  tokenDigest,
} from './services/token.service';
export type { TokenServiceOptions, AccessTokenClaims, AccessTokenRejection } from './services/token.service';
export { MenuService } from './services/menu.service';
export type { MenuNode } from './services/menu.service';
export { ThirdPartyAccountService } from './services/third-party-account.service';
export type { ThirdPartyProfile } from './services/third-party-account.service';
export { DepartmentDimensionProvider } from './services/department-dimension.provider';
export { UserService, PASSWORD_ENCODER } from './services/user.service';
export type { UserEntity, UserRoleBindingOptions } from './services/user.service';
export {
  RoleService,
  ROLE_EVENT_TOPICS,
  createRoleCreatedEvent,
  createRoleModifiedEvent,
  createRoleDeletedEvent,
} from './services/role.service';
export type { RoleEntity } from './services/role.service';
export { AuthorizationSettingService } from './services/authorization-setting.service';
export type { AuthorizationSettingEntity } from './services/authorization-setting.service';
export { DimensionUserService } from './services/dimension-user.service';
export type { DimensionUserEntity } from './services/dimension-user.service';
export { PermissionSyncService } from './services/permission-sync.service';

// Controllers
export { MenuController } from './controllers/menu.controller';
export { ThirdPartyAccountController } from './controllers/third-party-account.controller';
export {
  AuthorizationController,
  AUTHENTICATION_MANAGER,
} from './controllers/authorization.controller';
export type {
  LoginRequest,
  LoginResult,
  AuthenticationManagerLike,
} from './controllers/authorization.controller';
export { UserTokenController } from './controllers/user-token.controller';

// Strategies
export { JwtStrategy, JwtStrategyBase } from './strategies/jwt.strategy';
export type { JwtPayload } from './strategies/jwt.strategy';

// Events
export {
  AUTH_EVENT_TOPICS,
  type FieldChange,
  type UserCreatedEvent,
  type UserModifiedEvent,
  type UserDeletedEvent,
  type UserState,
  type UserStateChangedEvent,
  type DimensionBindEvent,
  type DimensionUnbindEvent,
  type DimensionDeletedEvent,
  type DimensionUserBind,
  type ClearUserAuthorizationCacheEvent,
  // Login lifecycle events
  type LoginBeforeEvent,
  type LoginDecodeEvent,
  type LoginSuccessEvent,
  type LoginFailedEvent,
  type LoginExitEvent,
  type AuthInitializeEvent,
  type AuthHandleBeforeEvent,
  // Token events
  type TokenCreatedEvent,
  type TokenChangedEvent,
  type TokenRemovedEvent,
  // Factories
  createUserCreatedEvent,
  createUserModifiedEvent,
  createUserDeletedEvent,
  createUserStateChangedEvent,
  createDimensionBindEvent,
  createDimensionUnbindEvent,
  createDimensionDeletedEvent,
  createDimensionUserBind,
  createClearAuthCacheEvent,
  createLoginBeforeEvent,
  createLoginDecodeEvent,
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createLoginExitEvent,
  createAuthInitializeEvent,
  createAuthHandleBeforeEvent,
  createTokenCreatedEvent,
  createTokenChangedEvent,
  createTokenRemovedEvent,
} from './events';

// Two-Factor Authentication
export type {
  TwoFactorValidator,
  TwoFactorValidatorProvider,
} from './two-factor/two-factor.interface';
export { TotpValidator, type TwoFactorStateStore } from './two-factor/totp-validator';
export { TwoFactorService, TWO_FACTOR_PROVIDERS } from './two-factor/two-factor.service';

// Password
export type { PasswordEncoder } from './password/password-encoder.interface';
export { BcryptEncoder } from './password/bcrypt-encoder';
export {
  PasswordValidator,
  type PasswordPolicy,
  DEFAULT_PASSWORD_POLICY,
} from './password/password-validator';
export {
  UsernameValidator,
  type UsernamePolicy,
  DEFAULT_USERNAME_POLICY,
} from './password/username-validator';
export type { UsernameValidationResult } from './password/username-validator';

// User Settings
export { UserSettingsService } from './services/user-settings.service';

// Define (permission resource/action definitions)
export type {
  ResourceDefinition,
  ResourceActionDefinition,
  DataAccessDefinition,
  DataAccessTypeDefinition,
  AuthorizeDefinition,
  DimensionDefinition,
  Logical,
  Phased,
  HandleType,
} from './define';
export {
  createResourceDefinition,
  createResourceActionDefinition,
  createDataAccessDefinition,
  createEmptyAuthorizeDefinition,
  addActionToResource,
  getActionIds,
  hasAction,
  getDataAccessActions,
  getDefinitionDescription,
  hasPermissionForResources,
} from './define';

// Handlers
export { UserAllowPermissionHandler } from './handlers/user-allow-permission.handler';
export type { AllowPermissionConfig } from './handlers/user-allow-permission.handler';

// Module
export { ZuckerAuthModule } from './auth.module';
export type { ZuckerAuthModuleAsyncOptions, ZuckerAuthModuleOptionsFactory } from './auth.module';

export { RefreshTokenService, RefreshTokenError, CacheRefreshTokenStore, InProcessRefreshTokenLock } from './session/refresh-token.service';
export type { RefreshTokenClaims, RefreshTokenPair, RefreshTokenOptions, RefreshTokenStore, RefreshTokenCache, RefreshTokenLock } from './session/refresh-token.service';

// Durable sessions and HttpOnly refresh-cookie transport
export { PersistentSessionService } from './session/persistent-session.service';
export { PersistentSessionRefreshTokenStore } from './session/persistent-refresh-token-store';
export type {
  PersistentSession,
  PersistentSessionOptions,
} from './session/persistent-session.service';
export { RefreshTokenCookie } from './session/refresh-token-cookie';
export type {
  RefreshTokenCookieOptions,
  RefreshCookieResponse,
} from './session/refresh-token-cookie';
export {
  ResourceOwnershipGuard,
  RESOURCE_OWNERSHIP_OPTIONS,
} from './guards/resource-ownership.guard';
export type { ResourceOwnershipOptions } from './guards/resource-ownership.guard';
export { OWN_CREATED_OPTIONS } from './data-access/own-created.handler';
export type { OwnCreatedHandlerOptions } from './data-access/own-created.handler';

export { ScryptEncoder } from './password/scrypt-encoder';

export {
  OAuthStateService,
  type OAuthStateOptions,
  type OAuthStatePayload,
  type OAuthStateFailure,
} from './oauth-state';

export { LoginAuditService, type LoginAuditData, type LoginAuditOptions } from './login-audit';
export { parseUserAgent, type ParsedUserAgent, type UserAgentLabels } from './user-agent';

export { OptionalJwtAuthGuard, OPTIONAL_JWT_AUTH_OPTIONS, type OptionalJwtAuthOptions } from './guards/optional-jwt-auth.guard';
export { createOAuthStateGuard } from './guards/oauth-state.guard';
export { createLocalAuthGuard, type LocalAuthGuardOptions } from './guards/local-auth.guard';
export {
  ApiKeyService,
  type ApiKeyRecord,
  type ApiKeyRateLimitResult,
  type ApiKeyServiceOptions,
  type CreateApiKeyParams,
  type ApiKeyValidationResult,
} from './api-key/api-key.service';
export { ApiKeyGuard, API_KEY_GUARD_OPTIONS, type ApiKeyGuardOptions } from './api-key/api-key.guard';

export {
  PERMISSIONS_GUARD_OPTIONS,
  type PermissionsGuardOptions,
} from './guards/permissions.guard';

export { exchangeGoogleOAuthCode, exchangeGitHubOAuthCode, OAuthCodeExchangeError } from './oauth-code-exchange';
export type { OAuthCodeExchangeProvider, OAuthCodeExchangeStage, OAuthCodeExchangeOptions, GoogleOAuthCodeExchangeOptions, GoogleOAuthCodeProfile, GitHubOAuthCodeProfile } from './oauth-code-exchange';

export { PostgresIdentityTransactions } from './identity-transactions';
export type { IdentityTransactions } from './identity-transactions';
export {
  VerificationCodeService, DatabaseVerificationCodeStore, CacheVerificationAttemptStore, VerificationCodeError,
} from './verification-code';
export type { VerificationCodeRecord, VerificationCodeStore, VerificationAttemptStore } from './verification-code';
export { OneTimeTicketService, DatabaseOneTimeTicketStore, OneTimeTicketError } from './one-time-ticket';
export type { OneTimeTicketRecord, OneTimeTicketStore } from './one-time-ticket';
export type { ThirdPartyAccountOptions, ThirdPartyBindRecord } from './services/third-party-account.service';
export type { PermissionImportOptions, PermissionImportRecord } from './services/permission.service';

export { GoogleIdTokenVerifier, GoogleIdTokenError } from './google-id-token';
export type { GoogleIdTokenVerifierOptions, GoogleIdTokenExpectation, GoogleIdTokenFailure, VerifiedGoogleIdentity } from './google-id-token';
export { OAuthProofService, OAuthProofError } from './oauth-proof';
export type { OAuthProofOptions, OAuthProofContext, OAuthProofRecord, VerifiedOAuthIdentity } from './oauth-proof';
export type { ThirdPartyBindingRequest, ThirdPartyBindingProofInput } from './services/third-party-account.service';
