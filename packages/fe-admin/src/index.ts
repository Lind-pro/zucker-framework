// App shell
export { createAdminApp, loadAdminMessages, resolvePages, type AdminApp, type CreateAdminAppOptions } from './app/create-admin-app';
export {
  defaultAdminEndpoints,
  defaultAdminPermissions,
  resolveConfig,
  resolvePermissions,
  type AdminAppConfig,
  type AdminEndpoints,
  type AdminLocaleOption,
  type AdminPageDefinition,
  type AdminPageKey,
  type AdminPermissionCodes,
  type AdminPermissionOverrides,
  type ResolvedAdminConfig,
  type ServerLabels,
} from './app/config';
export {
  useAdmin,
  useAdminApi,
  useAdminConfig,
  useAdminUser,
  usePageTitle,
  usePermissionCheck,
  useResource,
  type AdminContextValue,
  type ResourceState,
  type SessionStatus,
} from './app/context';
export {
  AdminTwoFactorRequiredError,
  createAdminSession,
  permissionsFromMe,
  type AdminTwoFactorFactor,
  type AdminApi,
  type AdminAuthStore,
  type AdminSession,
  type AdminUser,
  type RequestOptions,
  type RestoreResult,
} from './app/session';
export { findPage, matchesPath, menuLabel, menuTrail, pageTitle, visibleMenu, type BackendMenuItem, type PermissionCheck } from './app/menu';
export { AdminLayout, DisabledFeaturePage, ForbiddenPage, LanguageSwitcher, NotFoundPage, PageGate } from './app/layout';
export { LoginPage } from './app/login';

// i18n
export { zhCN, type AdminMessageKey, type AdminMessages } from './i18n/zh-CN';
export { enUS } from './i18n/en-US';
export { AdminI18nProvider, createServerLabel, createTranslate, useAdminI18n, type AdminI18nValue, type Translate } from './i18n/context';
export { formatMessage, type MessageParams } from './i18n/format';

// Component kit
export { cn } from './lib/cn';
export { Button, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/button';
export { Checkbox, Field, Input, Select, Switch, Textarea, type FieldProps, type SelectOption } from './components/inputs';
export { AdminToaster, EmptyState, ErrorState, LoadingState, Notice, StatusBadge, toast, type Tone } from './components/feedback';
export { JsonView, KeyValueList, PageContainer, Panel, type KeyValueItem } from './components/layout';
export { ConfirmButton, ConfirmDialog, Dialog, Drawer, type ConfirmDialogProps, type DialogProps } from './components/dialog';
export {
  FormDialog,
  FormField,
  FormFields,
  focusField,
  parseListInput,
  isoToLocalDateTime,
  localDateTimeToIso,
  useFormState,
  validateFields,
  type FieldSpec,
  type FieldType,
  type FormDialogProps,
  type FormErrors,
  type FormState,
  type FormValues,
} from './components/form';
export {
  DataTable,
  FilterBar,
  Pagination,
  ResourceTable,
  assertPage,
  useServerTable,
  type Column,
  type DataTableProps,
  type FilterSpec,
  type FilterValues,
  type PageLoader,
  type PageQuery,
  type PageResult,
  type PaginationState,
  type ResourceTableHandle,
  type ResourceTableProps,
  type ServerTable,
} from './components/data-table';
export { Tabs, type TabItem } from './components/tabs';

// Helpers
export { displayValue, errorBody, errorStatus, formatDate, formatDateTime, isAbortError, moneyText, readPath, type ErrorBody, type Money } from './lib/format';
export {
  clearOperationAttempt,
  findOperationAttempt,
  operationAttempt,
  type OperationAttempt,
} from './lib/operation-attempt';

// Pages (for composition into product routes or custom layouts)
export { createDefaultPages } from './pages/registry';
export { crudLoader, pageLoader, BatchDeleteButton, DeleteAction, confirmActor } from './pages/shared';
export {
  counterLabel,
  parseEntitlementCatalog,
  useEntitlementCatalog,
  type EntitlementCatalog,
  type EntitlementCounter,
  type EntitlementFeature,
} from './pages/entitlements';
export { DashboardPage } from './pages/dashboard';
export { UsersPage, UserRoleEditor, type UserRecord } from './pages/users';
export { RolesPage, PermissionTree, type PermissionGroup } from './pages/roles';
export { PermissionsPage } from './pages/permissions';
export { MenuPage } from './pages/menu';
export { DictionaryPage } from './pages/dictionary';
export {
  PlansPage,
  PlanEditor,
  DEFAULT_PAYMENT_PROVIDERS,
  emptyPlanDraft,
  emptyPriceDraft,
  planToDraft,
  priceText,
  validatePlanDraft,
  type PlanDraft,
  type PlanPrice,
  type PlanPriceDraft,
  type PlanValidationErrors,
  type PlanWrite,
  type SubscriptionPlan,
} from './pages/plans';
export {
  CreditPacksPage,
  CreditPackEditor,
  creditPackToDraft,
  emptyCreditPackDraft,
  validateCreditPackDraft,
  type CreditPack,
  type CreditPackDraft,
  type CreditPackPriceDraft,
  type CreditPackValidationErrors,
  type CreditPackWrite,
} from './pages/credit-packs';
export {
  UserSubscriptionsPage,
  BILLING_CYCLES,
  SUBSCRIPTION_STATUSES,
  assignmentInitialValues,
  assignmentPayload,
  type AssignmentFormValues,
  type QuotaSnapshot,
  type SubscriptionAssignmentBody,
  type UserSubscriptionDetail,
  type UserSubscriptionRow,
} from './pages/subscriptions';
export { QuotaUsagePage, QuotaReservationsPage, QUOTA_RESERVATION_STATUSES } from './pages/quota';
export {
  RecordsPage,
  recordDefinitions,
  OrdersPage,
  BillingSubscriptionsPage,
  JobsPage,
  DeliveriesPage,
  FilesPage,
  ApiKeysPage,
  AccessLogsPage,
  OperationLogsPage,
  type RecordDefinition,
  type RecordResource,
} from './pages/records';
export { RefundsPage, canonicalRefundAmount, type RefundTarget, type RefundView } from './pages/refunds';
export { CreditsPage } from './pages/credits';
export { EmailTemplatesPage, EmailLogsPage } from './pages/email';
export { AIModelsPage } from './pages/ai-models';
export { ConnectionsPage, type ConnectionField, type ConnectionProfile } from './pages/connections';
export { HealthPage } from './pages/health';
export { ProfilePage } from './pages/profile';
