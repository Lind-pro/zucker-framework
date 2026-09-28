import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException, BusinessException, NotFoundException } from '@zucker-framework/core';
import type { PasswordEncoder } from '../password/password-encoder.interface';
import { PasswordValidator } from '../password/password-validator';
import { UsernameValidator } from '../password/username-validator';
import { BcryptEncoder } from '../password/bcrypt-encoder';
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
  ) {
    this.passwordEncoder = passwordEncoder ?? new BcryptEncoder();
    this.passwordValidator = new PasswordValidator();
    this.usernameValidator = new UsernameValidator();
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
  async updateUser(id: string, changes: Partial<UserEntity>): Promise<UserEntity> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException('User not found');
    return this.doUpdate(existing, changes);
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
   * - Validates username and password
   * - Checks for duplicate username
   * - Generates salt and encodes password
   * - Publishes UserCreatedEvent
   */
  async addUser(
    data: Partial<UserEntity> & { username: string; password?: string },
  ): Promise<UserEntity> {
    // Validate username
    const usernameResult = this.usernameValidator.validate(data.username);
    if (!usernameResult.valid) {
      throw new ValidationException({ username: [usernameResult.errors.join(', ')] }, 'Invalid username');
    }

    // Validate password
    const rawPassword = data.password ?? '';
    const passwordResult = this.passwordValidator.validate(rawPassword);
    if (!passwordResult.valid) {
      throw new ValidationException({ password: [passwordResult.errors.join(', ')] }, 'Invalid password');
    }

    // Check duplicate username
    const existing = await this.findByUsername(data.username);
    if (existing) {
      throw new BusinessException('error.user_already_exists', 'USER_ALREADY_EXISTS', 409);
    }

    // Encode password
    const encodedPassword = await this.passwordEncoder.encode(rawPassword);

    // 构建用户数据：不传 salt（Prisma schema 无此字段，salt 已嵌入编码后的密码）
    // createTime 使用 Date 对象（兼容 Prisma DateTime 类型）
    const { password: _rawPw, ...rest } = data;
    const userEntity: Record<string, unknown> = {
      ...rest,
      password: encodedPassword,
      status: data.status ?? true,
      createTime: data.createTime ? new Date(data.createTime) : new Date(),
    };

    const created = (await this.db.model('users').create({
      data: userEntity,
    })) as UserEntity;

    // Publish UserCreatedEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.USER_CREATED,
      createUserCreatedEvent(created.id, created.username, data.creatorId),
    );

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

    await this.db.model('users').update({
      where: { id: old.id },
      data: updateData,
    });

    const updated = { ...old, ...updateData } as UserEntity;

    // Publish UserModifiedEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.USER_MODIFIED,
      createUserModifiedEvent(old.id, changes, undefined, passwordChanged),
    );

    // Clear authorization cache
    await this.publishEvent(
      AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
      createClearAuthCacheEvent(old.id, 'user_modified'),
    );

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
