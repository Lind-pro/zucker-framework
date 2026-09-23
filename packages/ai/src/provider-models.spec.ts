import { connect } from 'node:net';
// @vitest-environment node
import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listProviderModels } from './provider-models';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});
async function serve(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('provider model discovery', () => {
  it('uses the configured OpenAI-compatible endpoint and returns unique sorted IDs', async () => {
    const baseUrl = await serve((req, res) => {
      expect(req.url).toBe('/v1/models');
      expect(req.headers.authorization).toBe('Bearer synthetic-secret');
      res.end(JSON.stringify({ data: [{ id: 'model-z' }, { id: 'model-a' }, { id: 'model-z' }] }));
    });
    expect(
      await listProviderModels({ provider: 'Custom', apiKey: 'synthetic-secret', baseUrl }),
    ).toEqual([
      { id: 'model-a', name: 'model-a' },
      { id: 'model-z', name: 'model-z' },
    ]);
  });
  it('follows Anthropic cursors with the correct headers', async () => {
    const paths: string[] = [];
    const baseUrl = await serve((req, res) => {
      paths.push(req.url!);
      expect(req.headers['x-api-key']).toBe('synthetic-secret');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      const second = req.url!.includes('after_id=first');
      res.end(
        JSON.stringify({
          data: [{ id: second ? 'second' : 'first', display_name: second ? 'Second' : 'First' }],
          has_more: !second,
          last_id: 'first',
        }),
      );
    });
    expect(
      await listProviderModels({ provider: 'Claude', apiKey: 'synthetic-secret', baseUrl }),
    ).toHaveLength(2);
    expect(paths).toHaveLength(2);
  });
  it('lists Gemini pages and strips only the API resource prefix', async () => {
    const baseUrl = await serve((req, res) => {
      expect(req.headers['x-goog-api-key']).toBe('synthetic-secret');
      const second = req.url!.includes('pageToken=next');
      res.end(
        JSON.stringify({
          models: [{ name: second ? 'models/gemini-b' : 'models/gemini-a', displayName: 'Gemini' }],
          ...(second ? {} : { nextPageToken: 'next' }),
        }),
      );
    });
    expect(
      (await listProviderModels({ provider: 'Gemini', apiKey: 'synthetic-secret', baseUrl })).map(
        (m) => m.id,
      ),
    ).toEqual(['gemini-a', 'gemini-b']);
  });
  it('does not follow redirects or expose provider response bodies containing secrets', async () => {
    let requests = 0;
    const baseUrl = await serve((_req, res) => {
      requests++;
      res.writeHead(302, { Location: '/capture-secret' });
      res.end('synthetic-secret');
    });
    await expect(
      listProviderModels({ provider: 'OpenAI', apiKey: 'synthetic-secret', baseUrl }),
    ).rejects.toThrow('HTTP 302');
    expect(requests).toBe(1);
  });
  it('rejects malformed responses instead of returning invented model names', async () => {
    const baseUrl = await serve((_req, res) =>
      res.end(JSON.stringify({ data: [{ name: 'not-an-id' }] })),
    );
    await expect(
      listProviderModels({ provider: 'OpenAI', apiKey: 'synthetic-secret', baseUrl }),
    ).rejects.toThrow('identifier');
  });
  it('rejects repeated pagination cursors rather than silently truncating a catalogue', async () => {
    const baseUrl = await serve((_req, res) =>
      res.end(JSON.stringify({ data: [{ id: 'first' }], has_more: true, last_id: 'first' })),
    );
    await expect(
      listProviderModels({ provider: 'Claude', apiKey: 'synthetic-secret', baseUrl }),
    ).rejects.toThrow('pagination');
  });
});

it('routes discovery through the explicitly configured HTTP proxy', async () => {
  const baseUrl = await serve((_req, res) =>
    res.end(JSON.stringify({ data: [{ id: 'proxied-model' }] })),
  );
  let tunnels = 0;
  const proxy = createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels++;
    const [host, port] = req.url!.split(':');
    const target = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.write(head);
      client.pipe(target).pipe(client);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    client.on('close', () => target.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  try {
    const result = await listProviderModels({
      provider: 'OpenAI',
      apiKey: 'synthetic-secret',
      baseUrl,
      proxyHost: '127.0.0.1',
      proxyPort: address.port,
    });
    expect(result).toEqual([{ id: 'proxied-model', name: 'proxied-model' }]);
    expect(tunnels).toBe(1);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
