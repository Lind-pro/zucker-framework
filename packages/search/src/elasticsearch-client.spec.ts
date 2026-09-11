import { describe, expect, it, vi } from 'vitest';
import { ElasticsearchSearchClient, type ElasticsearchTransport } from './elasticsearch-client';

function createTransport() {
  return {
    index: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue({ hits: { total: 0, hits: [] } }),
    delete: vi.fn().mockResolvedValue({}),
    bulk: vi.fn().mockResolvedValue({ items: [] }),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    ping: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    cat: { plugins: vi.fn().mockResolvedValue([{ component: 'synthetic' }]) },
    cluster: { health: vi.fn().mockResolvedValue({ status: 'green' }) },
    indices: {
      create: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}),
      exists: vi.fn().mockResolvedValue(false), putMapping: vi.fn().mockResolvedValue({}),
      existsAlias: vi.fn().mockResolvedValue(false), putAlias: vi.fn().mockResolvedValue({}),
      getAlias: vi.fn().mockResolvedValue({}), updateAliases: vi.fn().mockResolvedValue({}),
    },
  } satisfies ElasticsearchTransport;
}

describe('ElasticsearchSearchClient modern transport', () => {
  it('initializes lazily once, adapts document/bulk/query shapes and closes once', async () => {
    const transport = createTransport();
    const createClient = vi.fn(() => transport);
    const client = new ElasticsearchSearchClient({ node: 'http://synthetic.invalid', createClient });
    expect(createClient).not.toHaveBeenCalled();
    await client.index({ index: 'documents', id: 'one', body: { title: 'synthetic' } });
    await client.bulk({ body: [{ index: { _index: 'documents', _id: 'one' } }, { title: 'synthetic' }] });
    const signal = new AbortController().signal;
    await client.search({ index: 'documents', body: { query: { match_all: {} }, from: 3, size: 4 } }, { signal });
    await client.indices.create({ index: 'documents', body: { settings: { number_of_shards: 1 }, mappings: { properties: {} } } });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(transport.index).toHaveBeenCalledWith({ index: 'documents', id: 'one', document: { title: 'synthetic' } });
    expect(transport.bulk).toHaveBeenCalledWith({ operations: expect.any(Array), refresh: false });
    expect(transport.search).toHaveBeenCalledWith({ index: 'documents', query: { match_all: {} }, from: 3, size: 4 }, { signal });
    expect(transport.indices.create).toHaveBeenCalledWith({ index: 'documents', settings: { number_of_shards: 1 }, mappings: { properties: {} } });
    await client.close();
    await client.close();
    expect(transport.close).toHaveBeenCalledTimes(1);
    await expect(client.ping()).rejects.toThrow('Search client is closed');
  });

  it('can close an unused adapter without constructing a transport', async () => {
    const createClient = vi.fn(() => createTransport());
    const client = new ElasticsearchSearchClient({ node: 'http://synthetic.invalid', createClient });
    await client.close();
    expect(createClient).not.toHaveBeenCalled();
  });
});
