export { DataSourceManager, type DataSourceDisposalOptions } from './datasource-manager';
export type {
  DataSourceConfig,
  DatabaseAdapter,
  DataSourceFactory,
} from './datasource-manager';

export {
  DataSourceHolder,
  getCurrentDataSourceId,
} from './datasource-holder';

export {
  UseDataSource,
  UseDefaultDataSource,
  USE_DATASOURCE_KEY,
  USE_DEFAULT_DATASOURCE_KEY,
  DataSourceInterceptor,
} from './datasource.decorator';
export type { UseDataSourceOptions } from './datasource.decorator';

export { DatabaseType } from './database-type';
export type { DatabaseTypeInfo, DatabaseTypeName } from './database-type';

export {
  DataSourceNotFoundException,
  DataSourceClosedException,
} from './datasource-errors';

export {
  DefaultSwitcher,
  DataSourceSwitcher,
} from './datasource-switcher';
export type { Switcher } from './datasource-switcher';

export {
  InMemoryDataSourceConfigRepository,
} from './datasource-config';
export type {
  DynamicDataSourceConfig,
  DynamicDataSourceConfigRepository,
} from './datasource-config';

export {
  CachedDataSourceSwitchStrategyMatcher,
} from './datasource-strategy';
export type {
  DataSourceSwitchStrategy,
  DataSourceSwitchStrategyMatcher,
} from './datasource-strategy';
