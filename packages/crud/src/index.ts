// Operators
export {
  type FilterOperatorType,
  type IFilterOperator,
  FILTER_OPERATORS,
  FilterOperatorFactory,
  ALL_OPERATORS,
  EqualsOperator,
  NotEqualsOperator,
  LikeOperator,
  NotLikeOperator,
  ContainsOperator,
  StartsWithOperator,
  EndsWithOperator,
  GtOperator,
  GteOperator,
  LtOperator,
  LteOperator,
  InOperator,
  NotInOperator,
  IsNullOperator,
  IsNotNullOperator,
  BetweenOperator,
  HasOperator,
  HasSomeOperator,
  EmptyOperator,
  NotEmptyOperator,
} from './operators';

// Expression Parser
export { parseExpression, parseFilterMap } from './expression-parser';

// Term Expression Parser（支持括号嵌套的完整解析器）
export { TermExpressionParser } from './expression/term-expression-parser';

// Dynamic Query
export {
  type DynamicQueryParam,
  DynamicQueryParamService,
  DynamicQueryService,
} from './dynamic-query.service';

// QueryParamEntity（DynamicQueryParam 增强封装）
export { QueryParamEntity } from './query/dynamic-query-param-entity';

// QueryParam — alias for QueryParamEntity, used as DTO base class
export { QueryParamEntity as QueryParam } from './query/dynamic-query-param-entity';

// QueryBuilder（链式查询 DSL）
export {
  QueryBuilder,
  type IQueryBuilder,
  type IJoinClause,
  type AggregateQueryArgs,
  type GroupByQueryArgs,
} from './query/query-builder';

// Base Service & Controller
export { BaseService } from './base.service';
export { BaseController, BaseControllerHost } from './base.controller';

// Cache Enabled Service
export {
  CacheEnabledService,
  Cacheable,
  type CacheEnabledServiceOptions,
} from './services/cache-enabled.service';

// Soft Delete Service
export {
  SoftDeleteService,
  type SoftDeletableEntity,
  type SoftDeleteQueryOptions,
} from './services/soft-delete.service';

// Tree Service & Controller
export { TreeService } from './tree.service';
export { TreeController, TreeControllerHost } from './tree.controller';

// Prisma Adapter
export { PrismaAdapter, type PrismaAdapterOptions } from './prisma-adapter';
export {
  PrismaDatabaseAdapterModule,
  type PrismaDatabaseAdapterModuleOptions,
} from './database-adapter.module';

// In-Memory Adapter (development / testing)
export { InMemoryAdapter } from './in-memory-adapter';

// Creator Event Listener
export {
  CreatorEventListener,
  type CurrentUserProvider,
  CURRENT_USER_PROVIDER,
} from './listeners/creator-event-listener';

// Validate Event Listener
export {
  ValidateEventListener,
  SimpleEntityValidationRegistry,
  type EntityValidationRegistry,
  ENTITY_VALIDATION_REGISTRY,
} from './listeners/validate-event-listener';

// Query Analyzer
export { QueryAnalyzer, type OptimizedQuery } from './query/query-analyzer';

// Pagination
export {
  type PaginatedResult,
  type SaveResult,
  rePaging,
  noPaging,
  isPaged,
  toPaginatedResult,
  calculateTotalPages,
  emptyPagerResult,
  mergeSaveResult,
} from './pagination';

// Module
export { DATABASE_ADAPTER, ZuckerCrudModule } from './crud.module';
export type { CrudModuleAsyncOptions } from './crud.module';

// CRUD Controller Factory
export { CrudControllerFactory, CRUD_METADATA } from './crud.decorator';
export type { CrudOptions, CrudRouteConfig } from './crud.decorator';
