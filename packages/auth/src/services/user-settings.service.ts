import { Injectable, Inject, Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { DATABASE_ADAPTER } from '../guards/data-permission.guard';
import type { SettingValueHolder } from '../interfaces';
import {
  UserSettingPermission,
  NullSettingValueHolder,
  createSettingValueHolder,
} from '../interfaces';

/**
 * User personalization settings service.
 *
 * Stores per-user settings keyed by userId + scope + key.
 */
@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  async get<T = unknown>(
    userId: string,
    scope: string,
    key: string,
  ): Promise<T | undefined> {
    const record = await this.db.model('userSettings').findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    }) as { value: unknown } | null;
    return record?.value as T | undefined;
  }

  /**
   * Get a setting as a SettingValueHolder.
   * Returns NullSettingValueHolder if not found.
   */
  async getSetting(
    userId: string,
    key: string,
    scope = 'default',
  ): Promise<SettingValueHolder> {
    const record = await this.db.model('userSettings').findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    }) as { value: unknown; permission?: string } | null;
    if (!record) return NullSettingValueHolder;
    const perm = (record.permission as UserSettingPermission) ?? UserSettingPermission.RW;
    return createSettingValueHolder(record.value, perm);
  }

  async set(
    userId: string,
    scope: string,
    key: string,
    value: unknown,
    permission: UserSettingPermission = UserSettingPermission.RW,
  ): Promise<void> {
    await this.db
      .model('userSettings')
      .update({
        where: { userId_scope_key: { userId, scope, key } },
        data: { value, permission, updatedAt: new Date() },
      })
      .catch(async () => {
        await this.db.model('userSettings').create({
          data: { userId, scope, key, value, permission },
        });
      });
  }

  /**
   * Save a setting with permission.
   */
  async saveSetting(
    userId: string,
    key: string,
    value: string,
    permission: UserSettingPermission = UserSettingPermission.RW,
    scope = 'default',
  ): Promise<void> {
    await this.set(userId, scope, key, value, permission);
  }

  async getAll(
    userId: string,
    scope: string,
  ): Promise<Record<string, unknown>> {
    const records = await this.db.model('userSettings').findMany({
      where: { userId, scope },
    }) as Array<{ key: string; value: unknown }>;
    const result: Record<string, unknown> = {};
    for (const record of records) {
      result[record.key] = record.value;
    }
    return result;
  }

  async delete(
    userId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await this.db.model('userSettings').delete({
      where: { userId_scope_key: { userId, scope, key } },
    }).catch(() => {
      // ignore if not exists
    });
  }

  async deleteAll(userId: string, scope?: string): Promise<void> {
    const where: Record<string, unknown> = { userId };
    if (scope) where.scope = scope;
    await this.db.model('userSettings').deleteMany({ where });
  }
}
