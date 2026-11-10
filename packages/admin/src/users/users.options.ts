/** Injection token for {@link UsersAdminOptions}. */
export const ADMIN_USERS_OPTIONS = Symbol('ADMIN_USERS_OPTIONS');
/** Injection token for the consumer's {@link AdminUserHooks} implementation. */
export const ADMIN_USER_HOOKS = Symbol('ADMIN_USER_HOOKS');

/** Change notification passed to {@link AdminUserHooks.sensitiveFieldsChanged}. */
export interface AdminUserSensitiveChange {
  userId: string;
  /** Sensitive fields present in the request whose value changed (`password` is always listed when sent). */
  fields: string[];
  /** The administrator who made the change. */
  actorId?: string;
}

/**
 * Consumer hooks for the admin user routes. Use them to apply the application's session policy
 * (e.g. bump a credential version and revoke refresh sessions after an administrator password
 * reset, disable or e-mail change). A hook error fails the request with the write already applied;
 * a retry with the same body runs the hook again.
 */
export interface AdminUserHooks {
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
