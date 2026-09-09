/**
 * Authorization lifecycle events.
 */

// ---- Topic constants ----
export const AUTH_EVENT_TOPICS = {
  // User lifecycle
  USER_CREATED: 'auth/user/created',
  USER_MODIFIED: 'auth/user/modified',
  USER_DELETED: 'auth/user/deleted',
  USER_STATE_CHANGED: 'auth/user/state-changed',

  // Dimension lifecycle
  DIMENSION_BIND: 'auth/dimension/bind',
  DIMENSION_UNBIND: 'auth/dimension/unbind',
  DIMENSION_DELETED: 'auth/dimension/deleted',

  // Login lifecycle
  LOGIN_BEFORE: 'auth/login/before',
  LOGIN_DECODE: 'auth/login/decode',
  LOGIN_SUCCESS: 'auth/login/success',
  LOGIN_FAILED: 'auth/login/failed',
  LOGIN_EXIT: 'auth/login/exit',

  // Authorization lifecycle
  AUTH_INITIALIZE: 'auth/initialize',
  AUTH_HANDLE_BEFORE: 'auth/handle/before',

  // Token lifecycle
  TOKEN_CREATED: 'auth/token/created',
  TOKEN_CHANGED: 'auth/token/changed',
  TOKEN_REMOVED: 'auth/token/removed',

  // Cache
  CLEAR_AUTH_CACHE: 'auth/cache/clear',
} as const;

// ---- Event payloads ----

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface UserCreatedEvent {
  userId: string;
  username: string;
  creator?: string;
  timestamp: Date;
}

export interface UserModifiedEvent {
  userId: string;
  changes: FieldChange[];
  /** 密码是否变更 */
  passwordChanged?: boolean;
  modifier?: string;
  timestamp: Date;
}

export interface UserDeletedEvent {
  userId: string;
  operator?: string;
  timestamp: Date;
}

export type UserState = 'enabled' | 'disabled' | 'locked';

export interface UserStateChangedEvent {
  userId: string;
  oldState: UserState;
  newState: UserState;
  operator?: string;
  timestamp: Date;
}

export interface DimensionBindEvent {
  userId: string;
  dimensionType: string;
  dimensionId: string;
  operator?: string;
  timestamp: Date;
}

export interface DimensionUnbindEvent {
  userId: string;
  dimensionType: string;
  dimensionId: string;
  operator?: string;
  timestamp: Date;
}

/**
 * 维度删除事件
 *
 * 当维度实体（如角色、部门）被删除时触发，
 * 用于级联清理该维度关联的授权配置。
 */
export interface DimensionDeletedEvent {
  dimensionType: string;
  dimensionId: string;
  timestamp: Date;
}

/**
 * 维度用户绑定信息
 *
 * 表示用户与维度的绑定关系，
 * 用于 DimensionUserBindProvider.getDimensionBindInfo() 返回值。
 */
export interface DimensionUserBind {
  userId: string;
  dimensionTypeId: string;
  dimensionId: string;
}

/**
 * Clear user authorization cache event.
 * If userId is undefined, all caches should be cleared.
 */
export interface ClearUserAuthorizationCacheEvent {
  userId?: string;
  reason?: string;
  timestamp: Date;
}

// ---- Login lifecycle event payloads  ----

/** Fired before login attempt. */
export interface LoginBeforeEvent {
  username: string;
  /** Additional parameters from the login request */
  parameters?: Record<string, unknown>;
  /**
   * Set by event handlers to short-circuit authentication with a known userId.
   */
  authorizedUserId?: string;
  /**
   * Set to true when pre-authorization has been established
   */
  isAuthorized?: boolean;
  timestamp: Date;
}

/** Fired to decode/transform credentials. */
export interface LoginDecodeEvent {
  username: string;
  /** Password to decode  */
  password?: string;
  /** Decoded/transformed username (set by handlers) */
  decodedUsername?: string;
  /** Decoded/transformed password (set by handlers) */
  decodedPassword?: string;
  /** Additional parameters from the login request */
  parameters?: Record<string, unknown>;
  timestamp: Date;
}

/** Fired after successful login. */
export interface LoginSuccessEvent {
  userId: string;
  username: string;
  /** Additional result data that handlers can attach  */
  result?: Record<string, unknown>;
  /** Additional parameters from the login request  */
  parameters?: Record<string, unknown>;
  timestamp: Date;
}

/** Fired after failed login attempt. */
export interface LoginFailedEvent {
  username: string;
  error: string;
  /** The actual exception/error object  */
  exception?: Error;
  /** Additional parameters from the login request */
  parameters?: Record<string, unknown>;
  timestamp: Date;
}

/** Fired when user logs out. */
export interface LoginExitEvent {
  userId: string;
  username?: string;
  timestamp: Date;
}

/** Fired when authentication is initialized/loaded. */
export interface AuthInitializeEvent {
  userId: string;
  timestamp: Date;
}

/** Fired before authorization check. */
export interface AuthHandleBeforeEvent {
  userId: string;
  permissionId: string;
  action: string;
  /** Set to true by handlers to explicitly allow */
  allow?: boolean;
  /** Set to true to skip default authorization logic */
  skip?: boolean;
  timestamp: Date;
}

// ---- Token event payloads  ----

/** Fired when a new token is created. */
export interface TokenCreatedEvent {
  token: string;
  userId: string;
  type: string;
  timestamp: Date;
}

/** Fired when a token state changes. */
export interface TokenChangedEvent {
  token: string;
  userId: string;
  oldState: string;
  newState: string;
  timestamp: Date;
}

/** Fired when a token is removed. */
export interface TokenRemovedEvent {
  token: string;
  userId: string;
  timestamp: Date;
}

// ---- Factory helpers ----

export function createUserCreatedEvent(
  userId: string,
  username: string,
  creator?: string,
): UserCreatedEvent {
  return { userId, username, creator, timestamp: new Date() };
}

export function createUserModifiedEvent(
  userId: string,
  changes: FieldChange[],
  modifier?: string,
  passwordChanged?: boolean,
): UserModifiedEvent {
  return { userId, changes, passwordChanged, modifier, timestamp: new Date() };
}

export function createUserDeletedEvent(
  userId: string,
  operator?: string,
): UserDeletedEvent {
  return { userId, operator, timestamp: new Date() };
}

export function createUserStateChangedEvent(
  userId: string,
  oldState: UserState,
  newState: UserState,
  operator?: string,
): UserStateChangedEvent {
  return { userId, oldState, newState, operator, timestamp: new Date() };
}

export function createDimensionBindEvent(
  userId: string,
  dimensionType: string,
  dimensionId: string,
  operator?: string,
): DimensionBindEvent {
  return { userId, dimensionType, dimensionId, operator, timestamp: new Date() };
}

export function createDimensionUnbindEvent(
  userId: string,
  dimensionType: string,
  dimensionId: string,
  operator?: string,
): DimensionUnbindEvent {
  return { userId, dimensionType, dimensionId, operator, timestamp: new Date() };
}

export function createDimensionDeletedEvent(
  dimensionType: string,
  dimensionId: string,
): DimensionDeletedEvent {
  return { dimensionType, dimensionId, timestamp: new Date() };
}

export function createDimensionUserBind(
  userId: string,
  dimensionTypeId: string,
  dimensionId: string,
): DimensionUserBind {
  return { userId, dimensionTypeId, dimensionId };
}

export function createClearAuthCacheEvent(
  userId?: string,
  reason?: string,
): ClearUserAuthorizationCacheEvent {
  return { userId, reason, timestamp: new Date() };
}

// ---- Login lifecycle event factories ----

export function createLoginBeforeEvent(
  username: string,
  parameters?: Record<string, unknown>,
): LoginBeforeEvent {
  return { username, parameters, timestamp: new Date() };
}

export function createLoginDecodeEvent(
  username: string,
  password?: string,
  parameters?: Record<string, unknown>,
): LoginDecodeEvent {
  return { username, password, parameters, timestamp: new Date() };
}

export function createLoginSuccessEvent(
  userId: string,
  username: string,
  result?: Record<string, unknown>,
  parameters?: Record<string, unknown>,
): LoginSuccessEvent {
  return { userId, username, result, parameters, timestamp: new Date() };
}

export function createLoginFailedEvent(
  username: string,
  error: string,
  exception?: Error,
  parameters?: Record<string, unknown>,
): LoginFailedEvent {
  return { username, error, exception, parameters, timestamp: new Date() };
}

export function createLoginExitEvent(
  userId: string,
  username?: string,
): LoginExitEvent {
  return { userId, username, timestamp: new Date() };
}

export function createAuthInitializeEvent(userId: string): AuthInitializeEvent {
  return { userId, timestamp: new Date() };
}

export function createAuthHandleBeforeEvent(
  userId: string,
  permissionId: string,
  action: string,
): AuthHandleBeforeEvent {
  return { userId, permissionId, action, timestamp: new Date() };
}

// ---- Token event factories ----

export function createTokenCreatedEvent(
  token: string,
  userId: string,
  type: string,
): TokenCreatedEvent {
  return { token, userId, type, timestamp: new Date() };
}

export function createTokenChangedEvent(
  token: string,
  userId: string,
  oldState: string,
  newState: string,
): TokenChangedEvent {
  return { token, userId, oldState, newState, timestamp: new Date() };
}

export function createTokenRemovedEvent(
  token: string,
  userId: string,
): TokenRemovedEvent {
  return { token, userId, timestamp: new Date() };
}
