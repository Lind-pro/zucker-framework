export { AccessLogger, ACCESS_LOGGER_KEY } from './access-logger.decorator';
export type { AccessLoggerOptions } from './access-logger.decorator';

export { AccessLoggerInterceptor, ACCESS_LOG_BUS } from './access-logger.interceptor';
export type { AccessLogBus } from './access-logger.interceptor';

export {
  ACCESS_LOG_EVENT,
  ACCESS_LOG_BEFORE_EVENT,
  OPERATION_LOG_EVENT,
  SYSTEM_LOG_EVENT,
  accessLogToSimpleMap,
} from './events';
export type {
  AccessLogPayload,
  OperationLogPayload,
  SystemLogPayload,
} from './events';

export {
  CorrelationIdMiddleware,
  getCorrelationId,
  runWithCorrelationId,
  runWithNewCorrelationId,
  CORRELATION_ID_HEADER,
} from './correlation-id';

export {
  StructuredLogger,
  LogLevel,
  registerTraceIdResolver,
} from './structured-logger';
export type { StructuredLogEntry } from './structured-logger';

export {
  BusinessLogger,
  BUSINESS_LOGGER_BUS,
  BUSINESS_LOG_EVENT,
} from './business-logger';
export type { BusinessLogEntry, BusinessLogBus } from './business-logger';

export { ZuckerLoggingModule } from './logging.module';

export { ACCESS_LOG_STORE, InMemoryAccessLogStore } from './access-log-store';
export type { AccessLogStore, AccessLogRecord, AccessLogQuery } from './access-log-store';

export { PiiFilter } from './pii-filter';
export type { PiiPattern, PiiFilterOptions } from './pii-filter';

export { AuditLogger, InMemoryAuditStore, AUDIT_STORE } from './audit-logger';
export type {
  AuditEntry,
  AuditLogInput,
  AuditStore,
  AuditQueryOptions,
  AuditAction,
  AuditSeverity,
  AuditActor,
  AuditTarget,
  AuditChange,
} from './audit-logger';
