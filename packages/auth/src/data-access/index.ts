// Config types
export type {
  DataAccessConfig,
  OwnCreatedDataAccessConfig,
  FieldFilterDataAccessConfig,
  ScopeDataAccessConfig,
  DimensionDataAccessConfig,
  DataAccessType,
} from './data-access-config';
export {
  DefaultDataAccessType,
  ownCreatedConfig,
  fieldFilterConfig,
  scopeConfig,
  dimensionConfig,
} from './data-access-config';

// Handler SPI
export type { DataAccessHandler, AuthorizingContext } from './data-access-handler';
export { DATA_ACCESS_HANDLERS } from './data-access-handler';

// Result types
export type { DataAccessResult, Term } from './data-access-result';
export { allowResult, denyResult, filterResult, mergeResults } from './data-access-result';

// Built-in handlers
export { OwnCreatedDataAccessHandler } from './own-created.handler';
export { FieldFilterDataAccessHandler } from './field-filter.handler';
export { ScopeDataAccessHandler } from './scope.handler';
export { DimensionDataAccessHandler } from './dimension.handler';
