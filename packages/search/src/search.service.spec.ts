import { SearchService, type SearchClient, type SearchResponse } from './search.service';

function createMockClient(): SearchClient {
  return {
    index: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue({
      hits: { total: { value: 0 }, hits: [] },
    } satisfies SearchResponse),
    delete: vi.fn().mockResolvedValue({}),
    bulk: vi.fn().mockResolvedValue({ items: [] }),
    indices: {
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      exists: vi.fn().mockResolvedValue(false),
      putMapping: vi.fn().mockResolvedValue({}),
    },
    count: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

describe('SearchService', () => {
  let service: SearchService;
  let client: SearchClient;

  beforeEach(() => {
    client = createMockClient();
    service = new SearchService(client);
  });

  describe('isAvailable', () => {
    it('should return true when client is injected', () => {
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when client is not injected', () => {
      const noClientService = new SearchService(undefined);
      expect(noClientService.isAvailable()).toBe(false);
    });
  });

  describe('indexDocument', () => {
    it('should index a document', async () => {
      await service.indexDocument('test-index', 'doc-1', { title: 'hello' });
      expect(client.index).toHaveBeenCalledWith({
        index: 'test-index',
        id: 'doc-1',
        body: { title: 'hello' },
      });
    });

    it('should throw when client is not configured', async () => {
      const noClient = new SearchService(undefined);
      await expect(noClient.indexDocument('idx', '1', {})).rejects.toThrow('Search client not configured');
    });
  });

  describe('bulkIndex', () => {
    it('should bulk index documents and report counts', async () => {
      (client.bulk as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [
          { index: {} },
          { index: { error: 'something' } },
          { index: {} },
        ],
      });

      const result = await service.bulkIndex('idx', [
        { id: '1', data: { a: 1 } },
        { id: '2', data: { b: 2 } },
        { id: '3', data: { c: 3 } },
      ]);

      expect(result).toEqual({ indexed: 2, errors: 1 });
      expect(client.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'idx', _id: '1' } },
          { a: 1 },
          { index: { _index: 'idx', _id: '2' } },
          { b: 2 },
          { index: { _index: 'idx', _id: '3' } },
          { c: 3 },
        ],
      });
    });

    it('should throw when client is not configured', async () => {
      const noClient = new SearchService(undefined);
      await expect(noClient.bulkIndex('idx', [])).rejects.toThrow('Search client not configured');
    });
  });

  describe('search', () => {
    it('should transform response into SearchResult', async () => {
      (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: {
          total: { value: 1 },
          hits: [
            { _id: 'doc-1', _score: 1.5, _source: { title: 'hello' }, highlight: { title: ['<em>hello</em>'] } },
          ],
        },
        aggregations: { count: { value: 42 } },
        suggest: { autocomplete: [] },
      } satisfies SearchResponse);

      const result = await service.search({
        index: 'test',
        query: { match_all: {} },
        from: 0,
        size: 10,
        sort: [{ createdAt: 'desc' }],
      });

      expect(result.total).toBe(1);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toEqual({
        id: 'doc-1',
        score: 1.5,
        source: { title: 'hello' },
        highlight: { title: ['<em>hello</em>'] },
      });
      expect(result.aggregations).toEqual({ count: { value: 42 } });
      expect(result.suggestions).toEqual({ autocomplete: [] });
    });

    it('should throw when client is not configured', async () => {
      const noClient = new SearchService(undefined);
      await expect(noClient.search({ index: 'x' })).rejects.toThrow('Search client not configured');
    });
  });

  describe('suggest', () => {
    it('should return suggestion texts', async () => {
      (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: { total: { value: 0 }, hits: [] },
        suggest: {
          autocomplete: [
            {
              options: [
                { text: 'apple' },
                { text: 'application' },
              ],
            },
          ],
        },
      });

      const result = await service.suggest('products', 'name.suggest', 'app', 5);
      expect(result).toEqual(['apple', 'application']);
    });

    it('should return empty array when no suggestions', async () => {
      (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: { total: { value: 0 }, hits: [] },
        suggest: { autocomplete: [{ options: [] }] },
      });

      const result = await service.suggest('products', 'name.suggest', 'xyz');
      expect(result).toEqual([]);
    });
  });

  describe('deleteDocument', () => {
    it('should delete a document', async () => {
      await service.deleteDocument('idx', 'doc-1');
      expect(client.delete).toHaveBeenCalledWith({ index: 'idx', id: 'doc-1' });
    });
  });

  describe('count', () => {
    it('should return count', async () => {
      (client.count as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 42 });
      const result = await service.count('idx', { match_all: {} });
      expect(result).toBe(42);
    });
  });

  describe('ensureIndex', () => {
    it('should create index when it does not exist', async () => {
      (client.indices.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await service.ensureIndex('new-idx', { properties: {} }, { number_of_shards: 1 });
      expect(client.indices.create).toHaveBeenCalledWith({
        index: 'new-idx',
        body: { mappings: { properties: {} }, settings: { number_of_shards: 1 } },
      });
    });

    it('should skip creation when index exists', async () => {
      (client.indices.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.ensureIndex('existing-idx');
      expect(client.indices.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteIndex', () => {
    it('should delete an index', async () => {
      await service.deleteIndex('old-idx');
      expect(client.indices.delete).toHaveBeenCalledWith({ index: 'old-idx' });
    });

    it('should throw when client is not configured', async () => {
      const noClient = new SearchService(undefined);
      await expect(noClient.deleteIndex('x')).rejects.toThrow('Search client not configured');
    });
  });
});

describe('SearchService connection and alias lifecycle', () => {
  it('initializes one client and creates a configured alias from discovered capabilities', async () => {
    const client = createMockClient();
    client.ping = vi.fn().mockResolvedValue(true);
    client.close = vi.fn().mockResolvedValue(undefined);
    client.getPlugins = vi.fn().mockResolvedValue(['synthetic-analyzer']);
    client.indices.existsAlias = vi.fn().mockResolvedValue(false);
    client.indices.putAlias = vi.fn().mockResolvedValue({});
    const definition = vi.fn().mockReturnValue({ mappings: { properties: { text: { type: 'text' } } } });
    const service = new SearchService(client, {
      ownsClient: true, aliases: [{ alias: 'documents', definition }],
    });
    await Promise.all([service.onModuleInit(), service.onModuleInit()]);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(definition).toHaveBeenCalledWith(['synthetic-analyzer']);
    expect(client.indices.create).toHaveBeenCalledTimes(1);
    expect(client.indices.create).toHaveBeenCalledWith({
      index: expect.stringMatching(/^documents_\d+$/),
      body: { mappings: { properties: { text: { type: 'text' } } }, aliases: { documents: { is_write_index: true } } },
    });
    expect(client.indices.putAlias).not.toHaveBeenCalled();
    expect(service.isHealthy()).toBe(true);
    await service.onModuleDestroy();
    await service.onModuleDestroy();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(service.isHealthy()).toBe(false);
  });

  it('does not touch disabled search and leaves externally owned clients open', async () => {
    const client = createMockClient();
    client.ping = vi.fn();
    client.close = vi.fn();
    const service = new SearchService(client, { enabled: false });
    await service.onModuleInit();
    await expect(service.indexDocument('index', 'id', {})).rejects.toThrow('Search client not configured');
    expect(client.ping).not.toHaveBeenCalled();
    expect(client.index).not.toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('keeps startup available after a dependency failure and exposes later health recovery', async () => {
    const client = createMockClient();
    const ping = vi.fn().mockRejectedValueOnce(new Error('dependency unavailable')).mockResolvedValue(true);
    client.ping = ping;
    const service = new SearchService(client);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isHealthy()).toBe(false);
    await expect(service.refreshHealth()).resolves.toBe(true);
    await service.onModuleDestroy();
  });

  it('switches aliases before retiring old indices and never deletes the active target', async () => {
    const client = createMockClient();
    client.indices.getAlias = vi.fn().mockResolvedValue({ previous: {}, replacement: {} });
    client.indices.updateAliases = vi.fn().mockResolvedValue({});
    const service = new SearchService(client);
    await service.switchAlias('documents', 'replacement', true);
    expect(client.indices.updateAliases).toHaveBeenCalledWith({ actions: [
      { remove: { index: 'previous', alias: 'documents' } },
      { add: { index: 'replacement', alias: 'documents' } },
    ] });
    expect(client.indices.delete).toHaveBeenCalledExactlyOnceWith({ index: 'previous' });
  });

  it('does not mutate aliases when discovery fails for a reason other than not found', async () => {
    const client = createMockClient();
    client.indices.getAlias = vi.fn().mockRejectedValue({ statusCode: 503 });
    client.indices.updateAliases = vi.fn();
    const service = new SearchService(client);
    await expect(service.switchAlias('documents', 'replacement', true)).rejects.toEqual({ statusCode: 503 });
    expect(client.indices.updateAliases).not.toHaveBeenCalled();
    expect(client.indices.delete).not.toHaveBeenCalled();
  });

  it('keeps numeric or missing hit totals compatible and forwards cancellation', async () => {
    const client = createMockClient();
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: { total: 2, hits: [] } });
    const service = new SearchService(client);
    const signal = new AbortController().signal;
    await expect(service.search({ index: 'documents' }, { signal })).resolves.toMatchObject({ total: 2 });
    expect(client.search).toHaveBeenCalledWith({ index: 'documents', body: {} }, { signal });
  });

  it('creates configured aliases once search recovers after a failed start (review M12)', async () => {
    const client = createMockClient();
    client.ping = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(true);
    let aliasExists = false;
    client.indices.existsAlias = vi.fn(async () => aliasExists);
    (client.indices.create as ReturnType<typeof vi.fn>).mockImplementation(async () => { aliasExists = true; });
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await service.onModuleInit();
    expect(client.indices.create).not.toHaveBeenCalled();

    await expect(service.refreshHealth()).resolves.toBe(true);
    expect(client.indices.create).toHaveBeenCalledTimes(1);
    await service.indexDocument('documents', '1', { a: 1 });
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it('refuses writes to a configured alias that cannot be set up', async () => {
    const client = createMockClient();
    client.indices.existsAlias = vi.fn().mockRejectedValue(new Error('down'));
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await expect(service.indexDocument('documents', '1', {})).rejects.toThrow('write refused');
    await expect(service.bulkIndex('documents', [{ id: '1', data: {} }])).rejects.toThrow('write refused');
    expect(client.index).not.toHaveBeenCalled();
    expect(client.bulk).not.toHaveBeenCalled();
    // unconfigured indices are unaffected
    await service.indexDocument('other', '1', {});
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it('treats a concurrent replica winning alias creation as success', async () => {
    const client = createMockClient();
    client.indices.existsAlias = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    (client.indices.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('alias has more than one write index'));
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await service.onModuleInit();
    expect(service.isHealthy()).toBe(true);
  });

  it('names the conflicting concrete index when existsAlias is false but exists is true (L13)', async () => {
    const client = createMockClient();
    client.indices.existsAlias = vi.fn().mockResolvedValue(false);
    (client.indices.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await expect(service.ensureAlias({ alias: 'documents', definition: {} })).rejects.toThrow(
      /alias "documents" cannot be created.*concrete index.*documents/s,
    );
    expect(client.indices.create).not.toHaveBeenCalled();
  });

  it('accepts a concurrently created alias (second existsAlias true) instead of failing (L13)', async () => {
    const client = createMockClient();
    client.indices.existsAlias = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    (client.indices.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true); // true also for an alias
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await expect(service.ensureAlias({ alias: 'documents', definition: {} })).resolves.toBeUndefined();
    expect(client.indices.create).not.toHaveBeenCalled();
    await service.indexDocument('documents', '1', { a: 1 });
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it('refused writes include the cause (L13)', async () => {
    const client = createMockClient();
    client.indices.existsAlias = vi.fn().mockResolvedValue(false);
    (client.indices.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const service = new SearchService(client, { aliases: [{ alias: 'documents', definition: {} }] });
    await expect(service.indexDocument('documents', '1', {})).rejects.toThrow(
      /write refused.*concrete index/s,
    );
    await expect(service.bulkIndex('documents', [{ id: '1', data: {} }])).rejects.toThrow(/write refused.*concrete index/s);
    expect(client.index).not.toHaveBeenCalled();
    expect(client.bulk).not.toHaveBeenCalled();
  });
});
