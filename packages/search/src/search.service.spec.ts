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
