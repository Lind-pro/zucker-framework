// Public surface of `@zucker-framework/back-office/management` (work package F5).
export { BackOfficeManagementModule } from './management.module';
export type { BackOfficeManagementModuleOptions } from './management.module';
export {
  DEFAULT_MANAGEMENT_MODELS,
  DEFAULT_MANAGEMENT_PERMISSIONS,
  DEFAULT_MANAGEMENT_TABLES,
  MANAGEMENT_RECORD_FEATURES,
  resolveManagementOptions,
} from './management.options';
export type {
  BackOfficeManagementOptions,
  ManagementFeature,
  ManagementModelKey,
  ManagementRecordFeature,
  ManagementTableKey,
  ResolvedManagementOptions,
} from './management.options';
export { BackOfficeManagementService } from './management.service';
export type { ManagementResource } from './management.service';
export { createManagementController, MANAGEMENT_RECORD_ROUTES } from './management.controller';
export type { ManagementControllerDependencies } from './management.controller';
export {
  MANAGEMENT_RECORDS,
  managementPagination,
  managementRecord,
  managementText,
  orderAmounts,
} from './management.records';
export type { ManagementRecordDefinition, ManagementRecordResource } from './management.records';
export { assertSqlTransaction } from './management.ports';
export type {
  ManagementConnectionsPort,
  ManagementCreditGrant,
  ManagementCreditLedgerPort,
  ManagementCreditsPort,
  ManagementRefundOrder,
  ManagementRefundSummaryPort,
  ManagementSqlTransaction,
} from './management.ports';
export {
  MANAGEMENT_CONNECTIONS,
  MANAGEMENT_CREDIT_LEDGER,
  MANAGEMENT_CREDITS,
  MANAGEMENT_OPTIONS,
  MANAGEMENT_REFUND_SUMMARY,
} from './management.tokens';
