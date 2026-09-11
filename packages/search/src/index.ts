export {
  SearchService,
  SEARCH_CLIENT,
} from './search.service';
export type {
  SearchClient,
  SearchResponse,
  SearchQuery,
  SearchResult,
  SearchServiceOptions,
  SearchIndexDefinition,
  SearchAliasDefinition,
} from './search.service';

export {
  ZuckerSearchModule,
} from './search.module';
export type {
  SearchModuleOptions,
  SearchModuleAsyncOptions,
  SearchModuleOptionsFactory,
} from './search.module';

export { SearchQueryBuilder } from './query-builder';

export { ElasticsearchSearchClient } from './elasticsearch-client';
export type { ElasticsearchClientOptions, ElasticsearchTransport } from './elasticsearch-client';
