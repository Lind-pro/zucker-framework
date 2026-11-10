import { Injectable, Logger, Optional, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';

export const SEARCH_CLIENT = 'SEARCH_CLIENT';

/**
 * Elasticsearch 客户端接口 — 不直接依赖 @elastic/elasticsearch，
 * 通过接口抽象允许用户注入任何兼容的客户端。
 */
export interface SearchClient {
  index(params: { index: string; id?: string; body: Record<string, unknown> }): Promise<unknown>;
  search(params: { index: string; body: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<SearchResponse>;
  delete(params: { index: string; id: string }): Promise<unknown>;
  bulk(params: { body: Array<Record<string, unknown>> }): Promise<unknown>;
  indices: {
    create(params: { index: string; body?: Record<string, unknown> }): Promise<unknown>;
    delete(params: { index: string }): Promise<unknown>;
    exists(params: { index: string }): Promise<boolean>;
    putMapping(params: { index: string; body: Record<string, unknown> }): Promise<unknown>;
    existsAlias?(params: { name: string }): Promise<boolean>;
    putAlias?(params: { index: string; name: string }): Promise<unknown>;
    getAlias?(params: { name: string }): Promise<Record<string, unknown>>;
    updateAliases?(params: { actions: Array<Record<string, { index: string; alias: string }>> }): Promise<unknown>;
  };
  count(params: { index: string; body?: Record<string, unknown> }): Promise<{ count: number }>;
  ping?(): Promise<unknown>;
  close?(): Promise<void>;
  getPlugins?(): Promise<string[]>;
  clusterHealth?(): Promise<string>;
}

export interface SearchIndexDefinition {
  mappings?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface SearchAliasDefinition {
  alias: string;
  indexPrefix?: string;
  definition: SearchIndexDefinition | ((plugins: readonly string[]) => SearchIndexDefinition | Promise<SearchIndexDefinition>);
}

export interface SearchServiceOptions {
  enabled?: boolean;
  /** Close the injected client once when this service is destroyed. */
  ownsClient?: boolean;
  aliases?: SearchAliasDefinition[];
}

export interface SearchResponse {
  hits: {
    total?: { value: number } | number;
    hits: Array<{
      _id: string;
      _score?: number | null;
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
  sort?: Array<Record<string, unknown>>;
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
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private healthy = false;
  private stopped = false;
  private initialization?: Promise<void>;
  private shutdown?: Promise<void>;
  /** 已确认存在的配置别名；在全部建立之前拒绝向这些别名写入 */
  private readonly readyAliases = new Set<string>();
  private aliasSetup?: Promise<void>;

  constructor(
    @Optional() @Inject(SEARCH_CLIENT) private readonly client?: SearchClient,
    @Optional() private readonly options: SearchServiceOptions = {},
  ) {}

  onModuleInit(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.initialization ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.client?.ping?.();
      await this.ensureConfiguredAliases();
      if (!this.stopped) this.healthy = true;
    } catch {
      this.healthy = false;
      this.logger.warn('Search initialization failed; consumer fallback remains available');
    }
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.healthy = false;
    return (this.shutdown ??= this.options.ownsClient ? this.client?.close?.() ?? Promise.resolve() : Promise.resolve());
  }

  isHealthy(): boolean { return this.isAvailable() && this.healthy; }

  async refreshHealth(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      await this.client?.ping?.();
      // 启动时 ES 不可用的情况下，恢复后补建配置的别名，再报告健康
      await this.ensureConfiguredAliases();
      this.healthy = !this.stopped;
    } catch { this.healthy = false; }
    return this.healthy;
  }

  /** 确保所有配置的别名存在；并发调用共享同一次执行，失败后可重试 */
  private ensureConfiguredAliases(): Promise<void> {
    const pending = (this.options.aliases ?? []).filter(item => !this.readyAliases.has(item.alias));
    if (pending.length === 0) return Promise.resolve();
    return (this.aliasSetup ??= (async () => {
      try {
        for (const alias of pending) await this.ensureAlias(alias);
      } finally {
        this.aliasSetup = undefined;
      }
    })());
  }

  /**
   * 写入配置别名前确保别名已经建立。否则 ES 会以别名为名自动创建一个动态映射的具体索引，
   * 之后配置的映射/分词器永远不会生效，别名也无法再创建。
   */
  private async assertWritable(index: string): Promise<void> {
    const configured = this.options.aliases?.some(item => item.alias === index);
    if (!configured || this.readyAliases.has(index)) return;
    try {
      await this.ensureConfiguredAliases();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Search alias is not initialized; write refused: ${reason}`);
    }
    if (!this.readyAliases.has(index)) throw new Error('Search alias is not initialized; write refused');
  }

  async getPlugins(): Promise<string[]> {
    if (!this.isAvailable()) return [];
    try { return await this.client?.getPlugins?.() ?? []; }
    catch {
      this.logger.warn('Search plugin discovery failed; using consumer fallback analyzers');
      return [];
    }
  }

  async ensureAlias(definition: SearchAliasDefinition): Promise<void> {
    const indices = this.client?.indices;
    if (!this.isAvailable() || !indices?.existsAlias) {
      throw new Error('Search alias management is not configured');
    }
    if (await indices.existsAlias({ name: definition.alias })) {
      this.readyAliases.add(definition.alias);
      return;
    }
    // A concrete index named like the alias (left by 1.0.18, which wrote to the alias name before
    // the alias existed) makes alias creation fail forever: report it instead of a generic error.
    if (await indices.exists({ index: definition.alias }).catch(() => false)) {
      // `exists` is also true for an alias: another replica may have just created it.
      if (await indices.existsAlias({ name: definition.alias }).catch(() => false)) {
        this.readyAliases.add(definition.alias);
        return;
      }
      throw new Error(
        `Search alias "${definition.alias}" cannot be created: a concrete index with that name exists. ` +
          'Reindex its documents into a new index (e.g. createIndexWithTimestamp), delete the old index, then restart.',
      );
    }
    try {
      // 别名在建索引的同一请求中声明为写索引：原子完成，且并发启动的另一副本会因
      // “别名已有写索引”而失败，不会出现一个别名挂两个索引且没有写索引的状态。
      await this.createIndexWithTimestamp(definition.alias, definition, true);
    } catch (error) {
      if (await indices.existsAlias({ name: definition.alias }).catch(() => false)) {
        this.readyAliases.add(definition.alias);
        return;
      }
      throw error;
    }
    this.readyAliases.add(definition.alias);
  }

  async createIndexWithTimestamp(alias: string, definition?: SearchAliasDefinition, asWriteAlias = false): Promise<string> {
    if (!this.isAvailable()) throw new Error('Search client not configured');
    const configured = definition ?? this.options.aliases?.find(item => item.alias === alias);
    if (!configured) throw new Error('Search index definition is not configured');
    const index = `${configured.indexPrefix ?? alias}_${Date.now()}`;
    const schema = typeof configured.definition === 'function'
      ? await configured.definition(await this.getPlugins()) : configured.definition;
    const aliases = asWriteAlias ? { [alias]: { is_write_index: true } } : undefined;
    await this.ensureIndex(index, schema.mappings, schema.settings, aliases);
    return index;
  }

  async switchAlias(alias: string, newIndex: string, deleteOldIndices = false): Promise<void> {
    const indices = this.client?.indices;
    if (!this.isAvailable() || !indices?.getAlias || !indices.updateAliases) {
      throw new Error('Search alias management is not configured');
    }
    let previous: string[];
    try { previous = Object.keys(await indices.getAlias({ name: alias })); }
    catch (error) {
      const status = error as { statusCode?: number; meta?: { statusCode?: number } };
      if ((status?.statusCode ?? status?.meta?.statusCode) !== 404) throw error;
      previous = [];
    }
    const actions: Array<Record<string, { index: string; alias: string }>> = previous
      .filter(index => index !== newIndex).map(index => ({ remove: { index, alias } }));
    actions.push({ add: { index: newIndex, alias } });
    await indices.updateAliases({ actions });
    if (deleteOldIndices) {
      for (const index of previous.filter(index => index !== newIndex)) {
        try { await indices.delete({ index }); }
        catch { this.logger.warn('Retired search index could not be deleted'); }
      }
    }
  }

  async getStats(index: string): Promise<{ documentCount: number; clusterHealth: string; healthy: boolean; error?: string }> {
    try {
      const documentCount = await this.count(index);
      const clusterHealth = await this.client?.clusterHealth?.() ?? 'unknown';
      return { documentCount, clusterHealth, healthy: this.isHealthy() };
    } catch {
      return { documentCount: 0, clusterHealth: 'unavailable', healthy: false, error: 'Search unavailable' };
    }
  }

  /** 检查搜索服务是否可用 */
  isAvailable(): boolean {
    return !!this.client && this.options.enabled !== false && !this.stopped;
  }

  /** 索引文档 */
  async indexDocument(index: string, id: string, document: Record<string, unknown>): Promise<void> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    await this.assertWritable(index);
    await this.client.index({ index, id, body: document });
  }

  /** 批量索引 */
  async bulkIndex(index: string, documents: Array<{ id: string; data: Record<string, unknown> }>): Promise<{ indexed: number; errors: number }> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    await this.assertWritable(index);
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
  async search<T = Record<string, unknown>>(query: SearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult<T>> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    const { index, from, size, sort, highlight, aggs, suggest, _source, ...rest } = query;
    const body: Record<string, unknown> = { ...rest };
    if (from !== undefined) body.from = from;
    if (size !== undefined) body.size = size;
    if (sort) body.sort = sort;
    if (highlight) body.highlight = highlight;
    if (aggs) body.aggs = aggs;
    if (suggest) body.suggest = suggest;
    if (_source) body._source = _source;

    const response = await this.client.search({ index, body }, options);
    return {
      total: typeof response.hits.total === 'number' ? response.hits.total : response.hits.total?.value ?? 0,
      hits: response.hits.hits.map(hit => ({
        id: hit._id,
        score: hit._score ?? 0,
        source: hit._source as T,
        highlight: hit.highlight,
      })),
      aggregations: response.aggregations,
      suggestions: response.suggest,
    };
  }

  /** 自动补全 */
  async suggest(index: string, field: string, text: string, size = 5): Promise<string[]> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
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
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    await this.client.delete({ index, id });
  }

  /** 统计 */
  async count(index: string, query?: Record<string, unknown>): Promise<number> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    const result = await this.client.count({ index, body: query ? { query } : undefined });
    return result.count;
  }

  /** 确保索引存在 */
  async ensureIndex(
    index: string,
    mappings?: Record<string, unknown>,
    settings?: Record<string, unknown>,
    aliases?: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    const exists = await this.client.indices.exists({ index });
    if (!exists) {
      const body: Record<string, unknown> = {};
      if (mappings) body.mappings = mappings;
      if (settings) body.settings = settings;
      if (aliases) body.aliases = aliases;
      await this.client.indices.create({ index, body });
      this.logger.log(`Index created: ${index}`);
    }
  }

  /** 删除索引 */
  async deleteIndex(index: string): Promise<void> {
    if (!this.client || !this.isAvailable()) throw new Error('Search client not configured');
    await this.client.indices.delete({ index });
  }
}
