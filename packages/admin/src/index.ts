// ─── Composition entry point ────────────────────────────────────────────────
export { ZuckerAdminModule } from './admin.module';
export type { ZuckerAdminModuleOptions, AdminFeature } from './admin.module';

// ─── Individual sub-modules (for cherry-pick usage) ─────────────────────────
export { ZuckerUsersAdminModule } from './users/users.module';
export { ZuckerRolesAdminModule } from './roles/roles.module';
export { ZuckerPermissionsAdminModule } from './permissions/permissions.module';
export { ZuckerDictionaryAdminModule } from './dictionary/dictionary.module';
export { ZuckerConfigAdminModule } from './config/config.module';
export { ZuckerCreditAdminModule } from './credit/credit.module';
export { ZuckerLoggingAdminModule } from './logging/logging.module';
export { ZuckerNotificationAdminModule } from './notification/notification.module';
export { ZuckerFormAdminModule } from './form/form.module';
export { ZuckerI18nAdminModule } from './i18n/i18n.module';
export type { I18nAdminModuleOptions } from './i18n/i18n.module';
export { ZuckerTenantAdminModule } from './tenant/tenant.module';
export type { TenantAdminModuleOptions } from './tenant/tenant.module';
export { ZuckerHealthModule } from './health/health.module';
export { ZuckerDashboardAdminModule } from './dashboard/dashboard.module';

// ─── Store interfaces & tokens (implement to replace in-memory stores) ───────
export { I18N_STORE, InMemoryI18nStore } from './i18n/i18n.store';
export type {
  I18nStoreInterface,
  I18nEntry,
  CreateI18nEntryRequest,
  UpdateI18nEntryRequest,
} from './i18n/i18n.store';
export { TENANT_STORE, InMemoryTenantStore } from './tenant/tenant.store';
export type {
  TenantStoreInterface,
  TenantRecord,
  CreateTenantRequest,
  UpdateTenantRequest,
} from './tenant/tenant.store';

// ─── Controllers (for testing or extending) ─────────────────────────────────
export { UsersController } from './users/users.controller';
export { RolesController } from './roles/roles.controller';
export { PermissionsController } from './permissions/permissions.controller';
export { DictionaryController } from './dictionary/dictionary.controller';
export { ConfigController } from './config/config.controller';
export { CreditController } from './credit/credit.controller';
export { LoggingController } from './logging/logging.controller';
export { NotificationController } from './notification/notification.controller';
export { FormController } from './form/form.controller';
export { I18nManagementController } from './i18n/i18n.controller';
export { TenantManagementController } from './tenant/tenant.controller';
export { HealthController } from './health/health.controller';
export { DashboardController } from './dashboard/dashboard.controller';

// ─── Public types ────────────────────────────────────────────────────────────
export type { DashboardStats } from './dashboard/dashboard.controller';

// Persistent audit management using the host's database-backed logging services.
export {
  createAccessLogAdminController,
  createOperationLogAdminController,
} from './logging/log-management.controller';
export type { LogManagementOptions } from './logging/log-management.controller';
export { createReadOnlyAdminController } from './read-only.controller';
export type { ReadOnlyAdminOptions } from './read-only.controller';
export { createLogQueryController } from './logging/log-query.controller';
export type { LogQueryControllerOptions } from './logging/log-query.controller';
export { createMailTemplateAdminController } from './notification/mail-template.controller';
export type {
  MailTemplateAdminOptions,
  MailTemplatePreview,
} from './notification/mail-template.controller';

export * from './notification/resend-webhook.controller';

export * from './ai/model.controller';

export * from './catalog.controller';
