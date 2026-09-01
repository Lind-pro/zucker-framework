import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ZuckerUsersAdminModule } from './users/users.module';
import { ZuckerRolesAdminModule } from './roles/roles.module';
import { ZuckerPermissionsAdminModule } from './permissions/permissions.module';
import { ZuckerDictionaryAdminModule } from './dictionary/dictionary.module';
import { ZuckerConfigAdminModule } from './config/config.module';
import { ZuckerCreditAdminModule } from './credit/credit.module';
import { ZuckerLoggingAdminModule } from './logging/logging.module';
import { ZuckerNotificationAdminModule } from './notification/notification.module';
import { ZuckerFormAdminModule } from './form/form.module';
import { ZuckerI18nAdminModule } from './i18n/i18n.module';
import { ZuckerTenantAdminModule } from './tenant/tenant.module';
import { ZuckerHealthModule } from './health/health.module';
import { ZuckerDashboardAdminModule } from './dashboard/dashboard.module';
import type { I18nStoreInterface } from './i18n/i18n.store';
import type { TenantStoreInterface } from './tenant/tenant.store';

/** All available feature names for ZuckerAdminModule.forRoot(). */
export type AdminFeature =
  | 'users'
  | 'roles'
  | 'permissions'
  | 'dictionary'
  | 'config'
  | 'credit'
  | 'logging'
  | 'notification'
  | 'form'
  | 'i18n'
  | 'tenant'
  | 'health'
  | 'dashboard';

export interface ZuckerAdminModuleOptions {
  /**
   * Which feature sub-modules to activate.
   * Defaults to all features when omitted.
   */
  features?: AdminFeature[];

  /**
   * Custom i18n store implementation.
   * Defaults to InMemoryI18nStore.
   *
   * @example
   * ```typescript
   * ZuckerAdminModule.forRoot({ i18nStore: MyDatabaseI18nStore })
   * ```
   */
  i18nStore?: Type<I18nStoreInterface>;

  /**
   * Custom tenant store implementation.
   * Defaults to InMemoryTenantStore.
   *
   * @example
   * ```typescript
   * ZuckerAdminModule.forRoot({ tenantStore: MyDatabaseTenantStore })
   * ```
   */
  tenantStore?: Type<TenantStoreInterface>;
}

const ALL_FEATURES: AdminFeature[] = [
  'users',
  'roles',
  'permissions',
  'dictionary',
  'config',
  'credit',
  'logging',
  'notification',
  'form',
  'i18n',
  'tenant',
  'health',
  'dashboard',
];

/** Static modules (no forRoot options needed) */
const STATIC_MODULE_MAP: Partial<Record<AdminFeature, unknown>> = {
  users: ZuckerUsersAdminModule,
  roles: ZuckerRolesAdminModule,
  permissions: ZuckerPermissionsAdminModule,
  dictionary: ZuckerDictionaryAdminModule,
  config: ZuckerConfigAdminModule,
  credit: ZuckerCreditAdminModule,
  logging: ZuckerLoggingAdminModule,
  notification: ZuckerNotificationAdminModule,
  form: ZuckerFormAdminModule,
  health: ZuckerHealthModule,
  dashboard: ZuckerDashboardAdminModule,
};

/**
 * ZuckerAdminModule — pluggable management REST API module for NestJS.
 *
 * Usage (enable all features with defaults):
 * ```typescript
 * ZuckerAdminModule.forRoot()
 * ```
 *
 * Usage (cherry-pick features):
 * ```typescript
 * ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'health'] })
 * ```
 *
 * Usage (custom store implementations):
 * ```typescript
 * ZuckerAdminModule.forRoot({
 *   i18nStore: MyDatabaseI18nStore,
 *   tenantStore: MyDatabaseTenantStore,
 * })
 * ```
 *
 * Prerequisites (must be configured in the host AppModule):
 * - EventEmitterModule.forRoot()
 * - ZuckerCrudModule.forRoot(...)      — provides DATABASE_ADAPTER globally
 * - ZuckerAuthModule.forRoot(...)      — provides JWT guards globally
 * - ZuckerFormModule.forRoot()         — provides FormService globally (required for 'form' feature)
 * - ZuckerLoggingModule.forRoot()      — provides ACCESS_LOG_EVENT globally
 * - ZuckerConfigModule.forRoot()       — provides ConfigService globally
 * - ZuckerDictionaryModule.forRoot()   — provides DictionaryService globally
 * - ZuckerNotificationModule.forRoot() — provides TemplateService globally
 * - ZuckerCreditModule.forRoot()       — provides CreditService globally
 */
@Module({})
export class ZuckerAdminModule {
  static forRoot(options: ZuckerAdminModuleOptions = {}): DynamicModule {
    const features = options.features ?? ALL_FEATURES;

    const imports = features
      .map((feature): unknown => {
        // Features with configurable stores use their own forRoot()
        if (feature === 'i18n') {
          return ZuckerI18nAdminModule.forRoot({ store: options.i18nStore });
        }
        if (feature === 'tenant') {
          return ZuckerTenantAdminModule.forRoot({ store: options.tenantStore });
        }
        return STATIC_MODULE_MAP[feature];
      })
      .filter(Boolean) as DynamicModule[];

    return {
      module: ZuckerAdminModule,
      imports,
    };
  }
}
