import { Injectable, Logger, Optional, Inject } from '@nestjs/common';

export const SEARCH_CLIENT = 'SEARCH_CLIENT';

/**
 * Elasticsearch 客户端接口 — 不直接依赖 @elastic/elasticsearch，
 * 通过接口抽象允许用户注入任何兼容的客户端。
 */
export interface SearchClient {
  index(params: { index: string; id?: string; body: Record<string, unknown> }): Promise<unknown>;
  search(params: { index: string; body: Record<string, unknown> }): Promise<SearchResponse>;
  delete(params: { index: string; id: string }): Promise<unknown>;
  bulk(params: { body: Array<Record<string, unknown>> }): Promise<unknown>;
  indices: {
    create(params: { index: string; body?: Record<string, unknown> }): Promise<unknown>;
    delete(params: { index: string }): Promise<unknown>;
    exists(params: { index: string }): Promise<boolean>;
    putMapping(params: { index: string; body: Record<string, unknown> }): Promise<unknown>;
  };
  count(params: { index: string; body?: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface SearchResponse {
  hits: {
    total: { value: number };
    hits: Array<{
      _id: string;
      _score: number;
      _source: Record<string, unknown>;
      highlight?: Record<string, string[]>;
    }>;
  };
  aggregations?: Record<string, unknown>;
  suggest?: Record<string, unknown>;
}

export interface SearchQuery {
  index: string;
  query?: Record<string, unknown>;
  from?: number;
  size?: number;
  sort?: Array<Record<string, 'asc' | 'desc'>>;
  highlight?: { fields: Record<string, Record<string, unknown>> };
  aggs?: Record<string, unknown>;
  suggest?: Record<string, unknown>;
  _source?: string[] | { includes?: string[]; excludes?: string[] };
}

export interface SearchResult<T = Record<string, unknown>> {
  total: number;
  hits: Array<{ id: string; score: number; source: T; highlight?: Record<string, string[]> }>;
  aggregations?: Record<string, unknown>;
  suggestions?: Record<string, unknown>;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @Optional() @Inject(SEARCH_CLIENT) private readonly client?: SearchClient,
  ) {}

  /** 检查搜索服务是否可用 */
  isAvailable(): boolean {
    return !!this.client;
  }

  /** 索引文档 */
  async indexDocument(index: string, id: string, document: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('Search client not configured');
    await this.client.index({ index, id, body: document });
  }

  /** 批量索引 */
  async bulkIndex(index: string, documents: Array<{ id: string; data: Record<string, unknown> }>): Promise<{ indexed: number; errors: number }> {
    if (!this.client) throw new Error('Search client not configured');
    const body: Array<Record<string, unknown>> = [];
    for (const doc of documents) {
      body.push({ index: { _index: index, _id: doc.id } });
      body.push(doc.data);
    }
    const result = await this.client.bulk({ body });
    const items = (result as any).items ?? [];
    const errorCount = items.filter((item: any) => item.index?.error).length;
    return { indexed: documents.length - errorCount, errors: errorCount };
  }

  /** 搜索 */
  async search<T = Record<string, unknown>>(query: SearchQuery): Promise<SearchResult<T>> {
    if (!this.client) throw new Error('Search client not configured');
    const { index, from, size, sort, highlight, aggs, suggest, _source, ...rest } = query;
    const body: Record<string, unknown> = { ...rest };
    if (from !== undefined) body.from = from;
    if (size !== undefined) body.size = size;
    if (sort) body.sort = sort;
    if (highlight) body.highlight = highlight;
    if (aggs) body.aggs = aggs;
    if (suggest) body.suggest = suggest;
    if (_source) body._source = _source;

    const response = await this.client.search({ index, body });
    return {
      total: response.hits.total.value,
      hits: response.hits.hits.map(hit => ({
        id: hit._id,
        score: hit._score,
        source: hit._source as T,
        highlight: hit.highlight,
      })),
      aggregations: response.aggregations,
      suggestions: response.suggest,
    };
  }

  /** 自动补全 */
  async suggest(index: string, field: string, text: string, size = 5): Promise<string[]> {
    if (!this.client) throw new Error('Search client not configured');
    const response = await this.client.search({
      index,
      body: {
        suggest: {
          autocomplete: {
            prefix: text,
            completion: { field, size },
          },
        },
        _source: false,
        size: 0,
      },
    });
    const suggestions = (response.suggest as any)?.autocomplete?.[0]?.options ?? [];
    return suggestions.filter((s: any) => s && s.text).map((s: any) => s.text as string);
  }

  /** 删除文档 */
  async deleteDocument(index: string, id: string): Promise<void> {
    if (!this.client) throw new Error('Search client not configured');
    await this.client.delete({ index, id });
  }

  /** 统计 */
  async count(index: string, query?: Record<string, unknown>): Promise<number> {
    if (!this.client) throw new Error('Search client not configured');
    const result = await this.client.count({ index, body: query ? { query } : undefined });
    return result.count;
  }

  /** 确保索引存在 */
  async ensureIndex(index: string, mappings?: Record<string, unknown>, settings?: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('Search client not configured');
    const exists = await this.client.indices.exists({ index });
    if (!exists) {
      const body: Record<string, unknown> = {};
      if (mappings) body.mappings = mappings;
      if (settings) body.settings = settings;
      await this.client.indices.create({ index, body });
      this.logger.log(`Index created: ${index}`);
    }
  }

  /** 删除索引 */
  async deleteIndex(index: string): Promise<void> {
    if (!this.client) throw new Error('Search client not configured');
    await this.client.indices.delete({ index });
  }
}
