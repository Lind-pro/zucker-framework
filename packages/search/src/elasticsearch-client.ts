import type { SearchClient, SearchResponse } from './search.service';

/** Elastic 9 transport shape. Kept separate from the legacy body-based SearchClient port. */
export interface ElasticsearchTransport {
  index(params: Record<string, unknown>): Promise<unknown>;
  search(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<SearchResponse>;
  delete(params: Record<string, unknown>): Promise<unknown>;
  bulk(params: Record<string, unknown>): Promise<unknown>;
  count(params: Record<string, unknown>): Promise<{ count: number }>;
  ping(): Promise<unknown>;
  close(): Promise<void>;
  cat: { plugins(params: { format: 'json' }): Promise<Array<{ component?: string }>> };
  cluster: { health(): Promise<{ status: string }> };
  indices: {
    create(params: Record<string, unknown>): Promise<unknown>;
    delete(params: { index: string }): Promise<unknown>;
    exists(params: { index: string }): Promise<boolean>;
    putMapping(params: Record<string, unknown>): Promise<unknown>;
    existsAlias(params: { name: string }): Promise<boolean>;
    putAlias(params: { index: string; name: string }): Promise<unknown>;
    getAlias(params: { name: string }): Promise<Record<string, unknown>>;
    updateAliases(params: { actions: Array<Record<string, { index: string; alias: string }>> }): Promise<unknown>;
  };
}

export interface ElasticsearchClientOptions {
  node: string;
  auth?: { username: string; password: string };
  createClient?: () => ElasticsearchTransport | Promise<ElasticsearchTransport>;
}

/** Lazy transport adapter; its SearchService owns initialization and close. */
export class ElasticsearchSearchClient implements SearchClient {
  private initialization?: Promise<ElasticsearchTransport>;
  private closing?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: ElasticsearchClientOptions) {}

  private client(): Promise<ElasticsearchTransport> {
    if (this.stopped) return Promise.reject(new Error('Search client is closed'));
    return (this.initialization ??= (async () => {
      if (this.options.createClient) return this.options.createClient();
      const { Client } = await import('@elastic/elasticsearch');
      return new Client({ node: this.options.node, auth: this.options.auth }) as unknown as ElasticsearchTransport;
    })());
  }

  async index({ body, ...params }: Parameters<SearchClient['index']>[0]): Promise<unknown> {
    return (await this.client()).index({ ...params, document: body });
  }
  async search({ body, ...params }: Parameters<SearchClient['search']>[0], options?: { signal?: AbortSignal }): Promise<SearchResponse> {
    return (await this.client()).search({ ...params, ...body }, options);
  }
  async delete(params: { index: string; id: string }): Promise<unknown> {
    return (await this.client()).delete({ ...params, refresh: false });
  }
  async bulk({ body }: Parameters<SearchClient['bulk']>[0]): Promise<unknown> {
    return (await this.client()).bulk({ operations: body, refresh: false });
  }
  async count({ body, ...params }: Parameters<SearchClient['count']>[0]): Promise<{ count: number }> {
    return (await this.client()).count({ ...params, ...body });
  }
  async ping(): Promise<unknown> { return (await this.client()).ping(); }
  async getPlugins(): Promise<string[]> {
    return (await (await this.client()).cat.plugins({ format: 'json' }))
      .flatMap(plugin => plugin.component ? [plugin.component] : []);
  }
  async clusterHealth(): Promise<string> { return (await (await this.client()).cluster.health()).status; }
  close(): Promise<void> {
    this.stopped = true;
    return (this.closing ??= this.initialization
      ? this.initialization.then(client => client.close(), () => undefined) : Promise.resolve());
  }

  readonly indices = {
    create: async ({ body, ...params }: { index: string; body?: Record<string, unknown> }) =>
      (await this.client()).indices.create({ ...params, ...body }),
    delete: async (params: { index: string }) => (await this.client()).indices.delete(params),
    exists: async (params: { index: string }) => (await this.client()).indices.exists(params),
    putMapping: async ({ body, ...params }: { index: string; body: Record<string, unknown> }) =>
      (await this.client()).indices.putMapping({ ...params, ...body }),
    existsAlias: async (params: { name: string }) => (await this.client()).indices.existsAlias(params),
    putAlias: async (params: { index: string; name: string }) => (await this.client()).indices.putAlias(params),
    getAlias: async (params: { name: string }) => (await this.client()).indices.getAlias(params),
    updateAliases: async (params: { actions: Array<Record<string, { index: string; alias: string }>> }) =>
      (await this.client()).indices.updateAliases(params),
  };
}
