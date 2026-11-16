import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException, BusinessException, NotFoundException, TransactionHolder } from '@zucker-framework/core';
import type { PasswordEncoder } from '../password/password-encoder.interface';
import { PasswordValidator } from '../password/password-validator';
import { UsernameValidator } from '../password/username-validator';
import { BcryptEncoder } from '../password/bcrypt-encoder';
import { TokenService } from './token.service';
import {
  AUTH_EVENT_TOPICS,
  createUserCreatedEvent,
  createUserModifiedEvent,
  createUserDeletedEvent,
  createUserStateChangedEvent,
  createClearAuthCacheEvent,
} from '../events/auth-events';
import type { UserState, FieldChange } from '../events/auth-events';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker-framework/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

/** User entity shape — 对齐 Prisma schema `model users` */
export interface UserEntity {
  id: string;
  username: string;
  password?: string;
  name: string;
  typeId: string;
  status: boolean;
  creatorId?: string;
  createTime?: Date | number;
  email?: string;
  emailVerified?: boolean;
  locale?: string;
  [key: string]: unknown;
}

export interface UserRoleBindingOptions {
  /** Consumer-owned fields, such as the existing relation's primary key. */
  bindingData?: (userId: string, roleId: string) => Record<string, unknown>;
}

/** Options for {@link UserService.addUser}. Omitted, `addUser` keeps its password-required contract. */
export interface AddUserOptions {
  /**
   * Create an account without a password credential (OAuth, magic link, e-mail code, provisioning).
   * `password` is stored as `null`; password validation and hashing are skipped. Username validation
   * and the duplicate-username check still apply. Passing a `password` together with this flag is
   * rejected, so a caller cannot silently create an account with an unvalidated credential.
   */
  passwordless?: boolean;
  /**
   * Adapter of a transaction the caller owns (the `tx` given to `DatabaseAdapter.$transaction`).
   * The duplicate-username lookup and the insert run on it, so they commit or roll back with the
   * caller's other writes. The `UserCreatedEvent` is published after that transaction commits
   * (via `TransactionHolder.afterCommit`) and is not published when it rolls back; an adapter that
   * does not register a transaction context publishes right after the insert.
   */
  transaction?: DatabaseAdapter;
}

/** Join a caller-owned update transaction while preserving this service's encoder and validators. */
export interface UpdateUserOptions {
  transaction?: DatabaseAdapter;
}

import { DATABASE_ADAPTER } from '@zucker-framework/crud';
const PASSWORD_ENCODER = Symbol('PASSWORD_ENCODER');
const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

export { PASSWORD_ENCODER };

/**
 * UserService
 *
 * Provides complete user lifecycle management:
 * - CRUD operations with duplicate-username protection
 * - Password encoding with per-user salt
 * - Username and password validation
 * - Status management (enable/disable)
 * - Event publishing for all user mutations
 * - Authorization cache invalidation on user changes
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private passwordEncoder: PasswordEncoder;
  private passwordValidator: PasswordValidator;
  private usernameValidator: UsernameValidator;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(PASSWORD_ENCODER) passwordEncoder?: PasswordEncoder,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly topicEventBus?: TopicEventBusLike,
    /**
     * When present, disabling, deleting or changing the password of a user revokes all of
     * that user's access tokens (cross-process when TokenService has a shared cache).
     */
    @Optional() private tokenService?: TokenService,
  ) {
    this.passwordEncoder = passwordEncoder ?? new BcryptEncoder();
    this.passwordValidator = new PasswordValidator();
    this.usernameValidator = new UsernameValidator();
  }

  /** Wire session revocation for constructions that bypass DI. */
  setTokenService(tokenService: TokenService): void {
    this.tokenService = tokenService;
  }

  private async revokeSessions(userId: string, reason: string): Promise<void> {
    if (!this.tokenService) return;
    await this.tokenService.revokeUserTokens(userId);
    this.logger.log(`Revoked sessions of user ${userId} (${reason})`);
  }

  /** Override the password encoder (e.g. for testing or custom schemes) */
  setPasswordEncoder(encoder: PasswordEncoder): void {
    this.passwordEncoder = encoder;
  }

  /** Override the password validator policy */
  setPasswordValidator(validator: PasswordValidator): void {
    this.passwordValidator = validator;
  }

  /** Override the username validator policy */
  setUsernameValidator(validator: UsernameValidator): void {
    this.usernameValidator = validator;
  }

  /**
   * Find a user by ID.
   */
  async findById(id: string): Promise<UserEntity | null> {
    return this.db.model('users').findUnique({ where: { id } }) as Promise<UserEntity | null>;
  }

  /**
   * Find a user by username.
   */
  async findByUsername(username: string): Promise<UserEntity | null> {
    if (!username) return null;
    const users = (await this.db.model('users').findMany({
      where: { username },
    })) as UserEntity[];
    return users[0] ?? null;
  }

  /**
   * Find a user by username and verify the plain-text password matches.
   * Returns null if user not found or password does not match.
   */
  async findByUsernameAndPassword(
    username: string,
    plainPassword: string,
  ): Promise<UserEntity | null> {
    const user = await this.findByUsername(username);
    if (!user || !user.password) return null;

    const matches = await this.passwordEncoder.matches(plainPassword, user.password);
    if (!matches) return null;
    const { password: _pw, ...safeUser } = user;
    return safeUser as UserEntity;
  }

  /**
   * Save a user (insert if no ID or not found, update if exists).
   */
  async saveUser(userEntity: Partial<UserEntity> & { username: string }): Promise<UserEntity> {
    if (!userEntity.id) {
      return this.addUser(userEntity);
    }

    const existing = await this.findById(userEntity.id);
    if (existing) {
      return this.doUpdate(existing, userEntity);
    }
    return this.addUser(userEntity);
  }

  /** Update only an existing account; missing accounts must not become inserts. */
  async updateUser(id: string, changes: Partial<UserEntity>, options: UpdateUserOptions = {}): Promise<UserEntity> {
    const db = options.transaction ?? this.db;
    const existing = await db.model('users').findUnique({ where: { id } }) as UserEntity | null;
    if (!existing) throw new NotFoundException('User not found');
    return this.doUpdate(existing, changes, db, !!options.transaction);
  }

  /** Replace role bindings on one adapter transaction, then invalidate authorization. */
  async setUserRoles(userId: string, roleIds: string[], options: UserRoleBindingOptions = {}): Promise<void> {
    if (typeof userId !== 'string' || !userId.trim() || !Array.isArray(roleIds) || roleIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new ValidationException({ roleIds: ['User and role identifiers must be non-empty strings'] });
    }
    await this.db.$transaction(async tx => {
      const user = await tx.model('users').findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      await tx.model('userRoles').deleteMany({ where: { userId } });
      for (const roleId of new Set(roleIds)) {
        await tx.model('userRoles').create({
          data: { ...options.bindingData?.(userId, roleId), userId, roleId },
        });
      }
    });
    await this.publishEvent(AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE, createClearAuthCacheEvent(userId, 'user_roles_changed'));
  }

  /**
   * Add a new user.
   *
   * - Validates username and, unless `options.passwordless`, the password
   * - Checks for duplicate username
   * - Encodes the password (passwordless accounts store `password: null`)
   * - Publishes UserCreatedEvent (after the caller's commit with `options.transaction`)
   */
  async addUser(
    data: Partial<UserEntity> & { username: string; password?: string },
    options: AddUserOptions = {},
  ): Promise<UserEntity> {
    const passwordless = options.passwordless === true;
    const db = options.transaction ?? this.db;

    // Validate username
    const usernameResult = this.usernameValidator.validate(data.username);
    if (!usernameResult.valid) {
      throw new ValidationException({ username: [usernameResult.errors.join(', ')] }, 'Invalid username');
    }

    if (passwordless) {
      // Explicit opt-in only: an absent password never implies a passwordless account.
      if (data.password !== undefined && data.password !== null) {
        throw new ValidationException({ password: ['A passwordless account cannot be created with a password'] }, 'Invalid password');
      }
    } else {
      const rawPassword = data.password ?? '';
      const passwordResult = this.passwordValidator.validate(rawPassword);
      if (!passwordResult.valid) {
        throw new ValidationException({ password: [passwordResult.errors.join(', ')] }, 'Invalid password');
      }
    }

    // Check duplicate username (inside the caller's transaction when given)
    const existing = options.transaction
      ? ((await db.model('users').findMany({ where: { username: data.username } })) as UserEntity[])[0]
      : await this.findByUsername(data.username);
    if (existing) {
      throw new BusinessException('error.user_already_exists', 'USER_ALREADY_EXISTS', 409);
    }

    // Encode only after the cheap checks pass.
    const encodedPassword = passwordless ? null : await this.passwordEncoder.encode(data.password ?? '');

    // 构建用户数据：不传 salt（Prisma schema 无此字段，salt 已嵌入编码后的密码）
    // createTime 使用 Date 对象（兼容 Prisma DateTime 类型）
    const { password: _rawPw, ...rest } = data;
    const userEntity: Record<string, unknown> = {
      ...rest,
      password: encodedPassword,
      status: data.status ?? true,
      createTime: data.createTime ? new Date(data.createTime) : new Date(),
    };

    const created = (await db.model('users').create({
      data: userEntity,
    })) as UserEntity;

    const publish = () => this.publishEvent(
      AUTH_EVENT_TOPICS.USER_CREATED,
      createUserCreatedEvent(created.id, created.username, data.creatorId),
    );
    // Without a caller transaction the insert is already committed: keep the immediate event.
    if (options.transaction) await TransactionHolder.afterCommit(publish);
    else await publish();

    return created;
  }

  /**
   * Update an existing user.
   *
   * - Re-encodes password if changed
   * - Publishes UserModifiedEvent with passwordChanged flag
   * - Clears authorization cache for the user
   */
  private async doUpdate(
    old: UserEntity,
    input: Partial<UserEntity>,
    db: DatabaseAdapter = this.db,
    inTransaction = false,
  ): Promise<UserEntity> {
    // Never mutate the caller's DTO or write undefined fields back to storage.
    const newer = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<UserEntity>;
    const changes: FieldChange[] = [];
    let passwordChanged = false;

    // Handle password update
    if (newer.password) {
      const passwordResult = this.passwordValidator.validate(newer.password);
      if (!passwordResult.valid) {
        throw new ValidationException({ password: [passwordResult.errors.join(', ')] }, 'Invalid password');
      }

      const matches = old.password ? await this.passwordEncoder.matches(newer.password, old.password) : false;
      passwordChanged = !matches;

      if (passwordChanged) {
        newer.password = await this.passwordEncoder.encode(newer.password);
        changes.push({ field: 'password', oldValue: '***', newValue: '***' });
      } else {
        // A matching plaintext password is not a replacement for its stored hash.
        delete newer.password;
      }
    } else {
      // Don't update password if not provided
      delete newer.password;
    }

    // Track other field changes
    for (const [key, value] of Object.entries(newer)) {
      if (key === 'password' || key === 'id') continue;
      if (old[key] !== value && value !== undefined) {
        changes.push({ field: key, oldValue: old[key], newValue: value });
      }
    }

    const updateData = { ...newer };
    delete updateData.id;

    await db.model('users').update({
      where: { id: old.id },
      data: updateData,
    });

    const updated = { ...old, ...updateData } as UserEntity;

    if (passwordChanged) {
      await this.revokeSessions(old.id, 'password changed');
    } else if (old.status && updateData.status === false) {
      await this.revokeSessions(old.id, 'disabled');
    }

    const publish = async () => {
      await this.publishEvent(AUTH_EVENT_TOPICS.USER_MODIFIED,
        createUserModifiedEvent(old.id, changes, undefined, passwordChanged));
      await this.publishEvent(AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
        createClearAuthCacheEvent(old.id, 'user_modified'));
    };
    if (inTransaction) await TransactionHolder.afterCommit(publish);
    else await publish();

    return updated;
  }

  /**
   * Change user status (enable/disable).
   *
   * - Batch update status for multiple user IDs
   * - Publishes UserStateChangedEvent
   */
  async changeState(userIds: string[], state: number | boolean): Promise<number> {
    if (userIds.length === 0) return 0;

    const boolState = typeof state === 'boolean' ? state : state === 1;
    const stateStr = boolState ? 'enabled' : 'disabled';

    // Update all users
    let updated = 0;
    for (const userId of userIds) {
      try {
        await this.db.model('users').update({
          where: { id: userId },
          data: { status: boolState },
        });
        updated++;
      } catch {
        // skip non-existent users
      }
    }

    if (!boolState) {
      for (const userId of userIds) await this.revokeSessions(userId, 'disabled');
    }

    // Publish UserStateChangedEvent
    for (const userId of userIds) {
      await this.publishEvent(
        AUTH_EVENT_TOPICS.USER_STATE_CHANGED,
        createUserStateChangedEvent(
          userId,
          (boolState ? 'disabled' : 'enabled') as UserState,
          stateStr as UserState,
        ),
      );
    }

    return updated;
  }

  /**
   * Change user password.
   *
   * - Verifies old password before allowing change
   * - Validates new password
   * - Publishes UserModifiedEvent with passwordChanged flag
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    // Validate new password
    const passwordResult = this.passwordValidator.validate(newPassword);
    if (!passwordResult.valid) {
      throw new ValidationException({ password: [passwordResult.errors.join(', ')] }, 'Invalid password');
    }

    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify old password
    if (!user.password) {
      throw new BusinessException('用户没有设置密码', 'NO_PASSWORD', 400);
    }
    const oldMatches = await this.passwordEncoder.matches(oldPassword, user.password);
    if (!oldMatches) {
      throw new BusinessException('error.illegal_user_password', 'ILLEGAL_PASSWORD', 400);
    }

    // 拒绝新旧密码相同
    const isSameAsOld = await this.passwordEncoder.matches(newPassword, user.password);
    if (isSameAsOld) {
      throw new BusinessException('新密码不能与旧密码相同', 'PASSWORD_SAME_AS_OLD', 400);
    }

    // Encode and save new password
    const encodedNewPassword = await this.passwordEncoder.encode(newPassword);
    const passwordChanged = true;

    await this.db.model('users').update({
      where: { id: userId },
      data: { password: encodedNewPassword },
    });
    // Every existing session, including the caller's, must re-authenticate.
    await this.revokeSessions(userId, 'password changed');

    // Publish UserModifiedEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.USER_MODIFIED,
      createUserModifiedEvent(
        userId,
        [{ field: 'password', oldValue: '***', newValue: '***' }],
        undefined,
        passwordChanged,
      ),
    );

    return passwordChanged;
  }

  /**
   * Delete a user.
   *
   * - Cleans only explicitly configured models with a userId field, on the same transaction.
   * - Any cleanup failure aborts deletion; no assumed tables or swallowed persistence errors.
   * - Publishes UserDeletedEvent
   */
  async deleteUser(userId: string, relatedModels: readonly string[]): Promise<boolean> {
    if (!Array.isArray(relatedModels) || relatedModels.some(model => typeof model !== 'string' || !model.trim() || model === 'users')) {
      throw new ValidationException({ relatedModels: ['Explicit related model names are required'] });
    }
    const user = await this.findById(userId);
    if (!user) return false;

    await this.db.$transaction(async (tx) => {
      for (const model of new Set(relatedModels)) {
        await tx.model(model).deleteMany({ where: { userId } });
      }
      await tx.model('users').delete({ where: { id: userId } });
    });
    await this.revokeSessions(userId, 'deleted');

    // Publish UserDeletedEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.USER_DELETED,
      createUserDeletedEvent(userId),
    );

    return true;
  }

  /**
   * Lock a user account.
   */
  async lockUser(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    await this.changeState([userId], 0);
  }

  /**
   * Unlock a user account.
   */
  async unlockUser(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    await this.changeState([userId], 1);
  }

  /**
   * Query users with dynamic filters.
   */
  async findUsers(
    where?: Record<string, unknown>,
  ): Promise<UserEntity[]> {
    return this.db.model('users').findMany({
      where: where ?? {},
    }) as Promise<UserEntity[]>;
  }

  /**
   * Count users matching a filter.
   */
  async countUsers(where?: Record<string, unknown>): Promise<number> {
    return this.db.model('users').count({ where: where ?? {} });
  }

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      try {
        await this.topicEventBus.publish(topic, payload);
      } catch (err) {
        this.logger.warn(`Failed to publish event ${topic}: ${err}`);
      }
    }
  }
}
