import {
  DefaultDataAccessType,
  type DataAccessConfig,
  type FieldFilterDataAccessConfig,
  type ScopeDataAccessConfig,
} from '../data-access/data-access-config';

// ============================================================
// Permission & Role
// ============================================================

/**
 * Standard permission action constants.
 */
export const PermissionActions = {
  QUERY: 'query',
  GET: 'get',
  ADD: 'add',
  SAVE: 'save',
  UPDATE: 'update',
  DELETE: 'delete',
  IMPORT: 'import',
  EXPORT: 'export',
  DISABLE: 'disable',
  ENABLE: 'enable',
} as const;

export interface Permission {
  id: string;
  name: string;
  actions: string[];
  describe?: string;
  /** Data-level access control configurations */
  dataAccesses: DataAccessConfig[];
  /** Extension options map  */
  options?: Record<string, unknown>;

  /** Find fields that should be denied for the given action */
  findDenyFields(action: string): string[];

  /** Find a specific DataAccessConfig by action and type */
  findDataAccess<T extends DataAccessConfig>(action: string, type: string): T | undefined;

  /** Get all DataAccessConfigs for a given action */
  getDataAccesses(action: string): DataAccessConfig[];

  /** Find a FieldFilterDataAccessConfig for the given action */
  findFieldFilter(action: string): FieldFilterDataAccessConfig | undefined;

  /** Find scope values for the given action, type and scopeType */
  findScope(action: string, type: string, scopeType: string): unknown[];

  /** Deep copy this permission */
  copy(
    actionFilter?: (action: string) => boolean,
    dataAccessFilter?: (config: DataAccessConfig) => boolean,
  ): Permission;
}

/**
 * Simple Permission implementation with data access helpers.
 */
export class SimplePermission implements Permission {
  id: string;
  name: string;
  actions: string[];
  describe?: string;
  dataAccesses: DataAccessConfig[];
  options?: Record<string, unknown>;

  constructor(data: {
    id: string;
    name: string;
    actions: string[];
    describe?: string;
    dataAccesses?: DataAccessConfig[];
    options?: Record<string, unknown>;
  }) {
    this.id = data.id;
    this.name = data.name;
    this.actions = data.actions;
    this.describe = data.describe;
    this.dataAccesses = data.dataAccesses || [];
    this.options = data.options;
  }

  /** Check if a config's action matches the requested action (supports '*' wildcard) */
  private actionMatches(configAction: string, requestedAction: string): boolean {
    return configAction === requestedAction || configAction === '*';
  }

  findDenyFields(action: string): string[] {
    const config = this.dataAccesses.find(
      (c) =>
        this.actionMatches(c.action, action) && c.type.id === DefaultDataAccessType.DENY_FIELDS.id,
    ) as FieldFilterDataAccessConfig | undefined;
    return config?.fields || [];
  }

  findDataAccess<T extends DataAccessConfig>(action: string, type: string): T | undefined {
    return this.dataAccesses.find(
      (c) => this.actionMatches(c.action, action) && c.type.id === type,
    ) as T | undefined;
  }

  getDataAccesses(action: string): DataAccessConfig[] {
    return this.dataAccesses.filter((c) => this.actionMatches(c.action, action));
  }

  findFieldFilter(action: string): FieldFilterDataAccessConfig | undefined {
    return this.dataAccesses.find(
      (c) =>
        this.actionMatches(c.action, action) && c.type.id === DefaultDataAccessType.DENY_FIELDS.id,
    ) as FieldFilterDataAccessConfig | undefined;
  }

  findScope(action: string, type: string, scopeType: string): unknown[] {
    const config = this.dataAccesses.find(
      (c) =>
        this.actionMatches(c.action, action) &&
        c.type.id === type &&
        'scopeType' in c &&
        (c as ScopeDataAccessConfig).scopeType === scopeType,
    ) as ScopeDataAccessConfig | undefined;
    return config?.scope || [];
  }

  copy(
    actionFilter: (action: string) => boolean = () => true,
    dataAccessFilter: (config: DataAccessConfig) => boolean = () => true,
  ): SimplePermission {
    return new SimplePermission({
      id: this.id,
      name: this.name,
      actions: this.actions.filter(actionFilter),
      describe: this.describe,
      dataAccesses: this.dataAccesses.filter(dataAccessFilter),
      options: this.options ? { ...this.options } : undefined,
    });
  }
}

export interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  parentId?: string;
}

export interface RoleTreeNode extends Role {
  children: RoleTreeNode[];
}

// ============================================================
// Dimension
// ============================================================

export interface DimensionType {
  id: string;
  name: string;
  isSameType(type: DimensionType | string): boolean;
}

export interface Dimension {
  id: string;
  name: string;
  type: DimensionType;
  options?: Record<string, unknown>;
}

// ============================================================
// DimensionProvider
// ============================================================

export interface DimensionProvider {
  /** 维度类型标识 */
  readonly dimensionType: string;
  getAllTypes(): Promise<DimensionType[]>;
  getDimensionsByUserId(userId: string): Promise<Dimension[]>;
  getDimensionById(type: DimensionType, id: string): Promise<Dimension | null>;
  getUserIdsByDimensionId(dimensionId: string): Promise<string[]>;
  /** 获取用户在该维度下的值列表 */
  getDimensionValues(userId: string): Promise<string[]>;
  /** 级联展开维度树（返回 value 及其所有子节点值） */
  expandDimensionTree(value: string): Promise<string[]>;
}

export const DIMENSION_PROVIDERS = Symbol('DIMENSION_PROVIDERS');

// ============================================================
// Token State
// ============================================================

export enum TokenState {
  NORMAL = 'normal',
  EXPIRED = 'expired',
  LOCK = 'lock',
  DENY = 'deny',
  REVOKED = 'revoked',
  OFFLINE = 'offline',
}

export interface TokenInfo {
  token: string;
  userId: string;
  state: TokenState;
  /** Token type (e.g. 'default', 'api', 'mobile'). */
  type: string;
  signInTime: Date;
  lastRequestTime: Date;
  /** Number of requests made with this token. */
  requestTimes: number;
  maxInactiveInterval?: number;
}

/**
 * Allopatric (concurrent) login mode.
 */
export enum AllopatricLoginMode {
  /** Deny login if user already logged in elsewhere */
  DENY = 'deny',
  /** Allow concurrent login (default) */
  ALLOW = 'allow',
  /** Kick existing sessions offline when new login occurs */
  OFFLINE_OTHER = 'offlineOther',
}

// ============================================================
// Authentication
// ============================================================

export interface AuthUser {
  id: string;
  username: string;
  [key: string]: unknown;
}

export interface Authentication {
  getUser(): AuthUser;
  getPermissions(): Permission[];
  getDimensions(type?: string): Dimension[];

  /** Get a specific permission by id  */
  getPermission(id: string): Permission | undefined;

  /** Get a specific dimension by type and id */
  getDimension(type: string, id: string): Dimension | undefined;

  hasPermission(permissionId: string, ...actions: string[]): boolean;
  hasDimension(type: string, ...ids: string[]): boolean;

  getAttributes(): Record<string, unknown>;
  getAttribute<T>(key: string): T | undefined;
  setAttribute(key: string, value: unknown): void;

  /** Merge another Authentication into this one */
  merge(other: Authentication): Authentication;

  /**
   * Copy with filters.
   * @param permissionFilter - (permission, action) => whether to keep the action
   * @param dimensionFilter - (dimension) => whether to keep the dimension
   */
  copy(
    permissionFilter?: (permission: Permission, action: string) => boolean,
    dimensionFilter?: (dimension: Dimension) => boolean,
  ): Authentication;
}

// ============================================================
// Auth Module Options
// ============================================================

export interface ZuckerAuthModuleOptions {
  thirdPartyAccounts?: import('../services/third-party-account.service').ThirdPartyAccountOptions;
  jwtSecret?: string;
  /**
   * Register the framework's generic authorization, menu, and third-party
   * account controllers. Defaults to true for backwards compatibility.
   *
   * Products that provide their own authentication surface should disable
   * these controllers to avoid exposing unused routes.
   */
  registerControllers?: boolean;
  dimensionProviders?: Array<new (...args: unknown[]) => DimensionProvider>;
  /**
   * 缓存 provider token（用于 Token 黑名单、撤销水位和共享会话活跃记录），指向 ICache 的注入 token.
   * With `forRootAsync`, prefer the top-level `cacheProvider` of the async options; an
   * options-level value is resolved at application bootstrap (startup fails if it does not
   * resolve). The provider must propagate write failures (see TokenService).
   */
  cacheProvider?: string | symbol;
  /**
   * With a cache configured, reject framework-tracked access tokens (claim `zsess`) whose shared
   * session record is missing — i.e. expired by inactivity on any instance. Default true.
   */
  enforceSessionInactivity?: boolean;
  /** 最大并发会话数，0 表示不限制 */
  maxActiveSessions?: number;
  /** Access-token lifetime passed to JwtModule (`expiresIn`). Default `'7d'`. */
  accessTokenTtl?: string | number;
  /** How a new login treats the user's existing sessions. Default ALLOW. */
  allopatricLoginMode?: AllopatricLoginMode;
  /**
   * TTL of token blacklist entries and per-user revocation watermarks (ms). Must be at least
   * the access-token lifetime. Default 7 days.
   */
  tokenBlacklistTtlMs?: number;
  /** Max staleness of the cached role hierarchy (ms). Default 60 000. */
  roleHierarchyCacheTtlMs?: number;
}

// ============================================================
// DefaultDimensionType
// ============================================================

/**
 * A simple DimensionType implementation that can be used as a constructor.
 */
export class SimpleDimensionType implements DimensionType {
  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}

  isSameType(type: DimensionType | string): boolean {
    if (typeof type === 'string') return this.id === type;
    return this === type || this.id === type.id;
  }
}

/**
 * Built-in dimension types.
 */
export const DefaultDimensionType = {
  user: new SimpleDimensionType('user', '用户'),
  role: new SimpleDimensionType('role', '角色'),
} as const;

// ============================================================
// SimpleDimension
// ============================================================

/**
 * Simple Dimension implementation.
 */
export class SimpleDimension implements Dimension {
  id: string;
  name: string;
  type: DimensionType;
  options?: Record<string, unknown>;

  constructor(id: string, name: string, type: DimensionType, options?: Record<string, unknown>) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.options = options;
  }

  static of(
    id: string,
    name: string,
    type: DimensionType,
    options?: Record<string, unknown>,
  ): SimpleDimension {
    return new SimpleDimension(id, name, type, options);
  }
}

// ============================================================
// AuthenticationPredicate
// ============================================================

/**
 * Predicate function for testing Authentication.
 */
export type AuthenticationPredicate = (auth: Authentication) => boolean;

/**
 * Factory methods for creating AuthenticationPredicates.
 */
export const AuthenticationPredicates = {
  /** Check if authentication has the given permission string (e.g. "user:query") */
  has(permissionString: string): AuthenticationPredicate {
    return createAuthenticationPredicate(permissionString);
  },

  /** Check dimension membership */
  dimension(dimensionType: string, ...ids: string[]): AuthenticationPredicate {
    return (auth) => auth.hasDimension(dimensionType, ...ids);
  },

  /** Check specific permission with actions */
  permission(permissionId: string, ...actions: string[]): AuthenticationPredicate {
    return (auth) => auth.hasPermission(permissionId, ...actions);
  },

  /** Combine two predicates with AND */
  and(a: AuthenticationPredicate, b: AuthenticationPredicate): AuthenticationPredicate {
    return (auth) => a(auth) && b(auth);
  },

  /** Combine two predicates with OR */
  or(a: AuthenticationPredicate, b: AuthenticationPredicate): AuthenticationPredicate {
    return (auth) => a(auth) || b(auth);
  },
} as const;

/**
 * Parse a permission string like "user:query" or "role:admin" into a predicate.
 */
export function createAuthenticationPredicate(permissionString: string): AuthenticationPredicate {
  if (!permissionString) return () => false;
  const parts = permissionString.split(':');
  if (parts.length >= 2) {
    const [resource, ...actions] = parts;
    return (auth) => auth.hasPermission(resource, ...actions);
  }
  // Single identifier — check as permission ID with no action constraint
  return (auth) => auth.hasPermission(permissionString);
}

// ============================================================
// UserSettingPermission
// ============================================================

/**
 * User setting read/write permission levels.
 */
export enum UserSettingPermission {
  NONE = 'NONE',
  R = 'R',
  W = 'W',
  RW = 'RW',
}

// ============================================================
// SettingValueHolder
// ============================================================

/**
 * Holds a user setting value with typed accessors.
 */
export interface SettingValueHolder {
  asString(): string | undefined;
  asNumber(): number | undefined;
  asBoolean(): boolean | undefined;
  asList<T>(): T[] | undefined;
  getValue(): unknown;
  getPermission(): UserSettingPermission;
}

/**
 * Null object for SettingValueHolder.
 * All accessors return undefined, permission is NONE.
 */
export const NullSettingValueHolder: SettingValueHolder = {
  asString: () => undefined,
  asNumber: () => undefined,
  asBoolean: () => undefined,
  asList: () => undefined,
  getValue: () => undefined,
  getPermission: () => UserSettingPermission.NONE,
};

/**
 * Create a SettingValueHolder from a raw value and permission.
 */
export function createSettingValueHolder(
  value: unknown,
  permission: UserSettingPermission = UserSettingPermission.RW,
): SettingValueHolder {
  if (value === null || value === undefined) return NullSettingValueHolder;
  return {
    asString: () => (typeof value === 'string' ? value : String(value)),
    asNumber: () => {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return isNaN(n) ? undefined : n;
    },
    asBoolean: () => {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    },
    asList: <T>() => {
      if (Array.isArray(value)) return value as T[];
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as T[];
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    getValue: () => value,
    getPermission: () => permission,
  };
}

// ============================================================
// DataAccessConfigDefaultType (re-export alias)
// ============================================================

export { DefaultDataAccessType as DataAccessConfigDefaultType } from '../data-access/data-access-config';

// ============================================================
// TokenInfoUtils
// ============================================================

/**
 * Utility helpers for TokenInfo
 * (isNormal, isExpired, isOffline, isDeny, isLock, checkExpired, validate).
 */
export const TokenInfoUtils = {
  isNormal(token: TokenInfo): boolean {
    return token.state === TokenState.NORMAL;
  },
  isExpired(token: TokenInfo): boolean {
    return token.state === TokenState.EXPIRED;
  },
  isOffline(token: TokenInfo): boolean {
    return token.state === TokenState.OFFLINE;
  },
  isDeny(token: TokenInfo): boolean {
    return token.state === TokenState.DENY;
  },
  isLock(token: TokenInfo): boolean {
    return token.state === TokenState.LOCK;
  },
  /** Check if the token has exceeded its maxInactiveInterval. */
  checkExpired(token: TokenInfo): boolean {
    if (!token.maxInactiveInterval || token.maxInactiveInterval <= 0) return false;
    return Date.now() - token.lastRequestTime.getTime() > token.maxInactiveInterval;
  },
  /** Validate token is in normal state, throw if not. */
  validate(token: TokenInfo): boolean {
    if (token.state !== TokenState.NORMAL) {
      throw new Error(`Token is ${token.state}`);
    }
    return true;
  },
} as const;
