import type { DatabaseAdapter } from '@zucker-framework/core';

/** Injection token for {@link UsersAdminOptions}. */
export const ADMIN_USERS_OPTIONS = Symbol('ADMIN_USERS_OPTIONS');
/** Injection token for the consumer's {@link AdminUserHooks} implementation. */
export const ADMIN_USER_HOOKS = Symbol('ADMIN_USER_HOOKS');

/** Credential change passed to {@link AdminUserHooks.sensitiveFieldsChanging}. */
export interface AdminUserSensitiveChange {
  userId: string;
  /** Sensitive fields present in the request whose value changed (`password` is always listed when sent). */
  fields: string[];
  /** The administrator who made the change. */
  actorId?: string;
}

/**
 * Consumer hooks for admin user routes. Required security effects belong in
 * `sensitiveFieldsChanging`: the credential edit and its revocation commit or roll back together.
 */
export interface AdminUserHooks {
  /**
   * Product policy before a validated user update. Runs after the user row is locked,
   * in the same transaction as the mutation. Use only `tx` for policy reads/locks;
   * throw to reject without writing or publishing credential-change events.
   */
  userChanging?(change: { userId: string; changes: Readonly<Record<string, unknown>>; actorId?: string }, tx: DatabaseAdapter): Promise<void>;
  /**
   * Product policy before replacing role bindings. Runs after locking the user and
   * before locking requested roles, so a policy can acquire its own stable role lock.
   * Do not perform external effects; an error aborts the entire mutation.
   */
  userRolesChanging?(change: { userId: string; roleIds: readonly string[]; expiries?: Readonly<Record<string, string | null>>; actorId?: string }, tx: DatabaseAdapter): Promise<void>;
  /**
   * Runs with the user's row locked, after its edit and before commit. Write ONLY through `tx`:
   * opening another transaction that locks this user can deadlock. An error rolls the edit back.
   * When present this replaces the legacy `sensitiveFieldsChanged` callback.
   */
  sensitiveFieldsChanging?(change: AdminUserSensitiveChange, tx: DatabaseAdapter): Promise<void>;
  /**
   * @deprecated Old direct callers may retain this method, but UsersController refuses a hook
   * with this method alone at construction. Implement `sensitiveFieldsChanging` before upgrading;
   * post-commit revocation cannot guarantee credential safety or retry recovery.
   */
  sensitiveFieldsChanged?(change: AdminUserSensitiveChange): Promise<void>;
  /** Called after a user and its role/permission links were deleted. */
  userDeleted?(userId: string, actorId?: string): Promise<void>;
}

export interface UsersAdminOptions {
  /** Extra consumer columns an operator with `users:update` may write (create and update). */
  writableFields?: readonly string[];
  /** Extra consumer columns returned by the read and write routes. Credentials are never returned. */
  readableFields?: readonly string[];
}

/** Profile fields writable with `users:update`. */
export const USER_PROFILE_FIELDS = ['name', 'locale'] as const;
/** Fields that change identity or access: changing them also requires `users:authorize`. */
export const USER_SENSITIVE_FIELDS = ['password', 'email', 'emailVerified', 'status', 'typeId'] as const;
/** Fields accepted by `POST /users` (besides `writableFields`). */
export const USER_CREATE_FIELDS = ['username', ...USER_PROFILE_FIELDS, ...USER_SENSITIVE_FIELDS] as const;
/** Fields returned by the admin user routes (besides `readableFields`). */
export const USER_READABLE_FIELDS = [
  'id', 'username', 'name', 'typeId', 'status', 'email', 'emailVerified', 'locale',
  'creatorId', 'createTime', 'createdAt', 'updatedAt',
] as const;
