export {
  type StorageAdapter,
  type AuthStoreConfig,
  type AuthState,
  type AuthStore,
  createAuthStore,
} from './store';

export { createUseAuthHydration, type AuthHydrationStore } from './hydration';
export { isSafeRelativeRedirect } from './redirect';
export {
  acceptsSessionToken,
  createSessionRequestScope,
  jwtSessionKey,
  sessionIdentity,
  type SessionKey,
  type SessionSnapshot,
} from './session';
export {
  createCookieSession,
  createSessionSummaryStorage,
  type CookieSession,
  type CookieSessionOptions,
  type CookieSessionRestoreResult,
  type SessionSummaryStorage,
  type SessionSummaryStorageOptions,
} from './cookie-session';
export {
  OAUTH_POPUP_CHANNEL_PREFIX,
  claimOAuthPopup,
  openOAuthPopup,
  parseOAuthPopupMessage,
  type ClaimOAuthPopupOptions,
  type OAuthPopupChannel,
  type OAuthPopupChannelFactory,
  type OAuthPopupClaim,
  type OAuthPopupHandle,
  type OAuthPopupResult,
  type OAuthPopupWindow,
  type OpenOAuthPopupOptions,
} from './oauth-popup';
