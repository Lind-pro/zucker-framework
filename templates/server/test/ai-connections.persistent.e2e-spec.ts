import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  AIConfigService,
  AICallObserverRegistry,
  AICallWrapper,
  NativeAIClient,
  type AIModelConfig,
  type NativeChatRequest,
  type NativeModelFactory,
} from '@zucker-framework/ai';
import { createNativeAIModel } from '@zucker-framework/ai/native';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
import {
  AI_CONNECTIONS,
  aiConnectionConfig,
  inspectAIConnections,
  validateAIConnection,
  type AIConnectionDefinition,
} from '../src/ai-connections/ai-connections.config';
import { aiModuleOptionsFromEnvironment } from '../src/ai-connections/runtime-ai-config.source';
import { CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';

const secret = 'SYNTHETIC-NATIVE-CONNECTION-SECRET',
  origin = 'http://localhost:4323';
function values(definition: AIConnectionDefinition) {
  return {
    [`${definition.prefix}_ENABLED`]: 'true',
    [`${definition.prefix}_MODEL_ID`]: `synthetic-${definition.provider}-model`,
    [`${definition.prefix}_MAX_TOKENS`]: '128',
    [`${definition.prefix}_TIMEOUT_MS`]: '2500',
    ...(!definition.baseURL
      ? { [`${definition.prefix}_BASE_URL`]: 'https://compatible.example.invalid/v1' }
      : {}),
  };
}
function environment(definition: AIConnectionDefinition) {
  return { ...values(definition), [`${definition.prefix}_API_KEY`]: secret };
}

describe('native AI connection local assembly contracts', () => {
  it('constructs all six actual native SDK adapters without making a remote request', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Remote model calls are forbidden'));
    try {
      for (const definition of AI_CONNECTIONS) {
        const factory = vi.fn(createNativeAIModel);
        await validateAIConnection(definition.id, environment(definition), { factory });
        expect(factory).toHaveBeenCalledOnce();
        expect(factory.mock.calls[0][0]).toMatchObject({
          providerId: definition.provider,
          modelId: `synthetic-${definition.provider}-model`,
          maxTokens: 128,
          timeoutMs: 2500,
        });
        const adapter = await factory.mock.results[0].value;
        expect(typeof adapter.chat).toBe('function');
        expect(typeof adapter.stream).toBe('function');
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('fails missing SDKs, credentials, model IDs, Anthropic token limits and unsafe addresses before adapter use', async () => {
    const factory: NativeModelFactory = vi.fn();
    for (const definition of AI_CONNECTIONS) {
      await expect(
        validateAIConnection(definition.id, environment(definition), {
          sdkAvailable: () => false,
          factory,
        }),
      ).rejects.toMatchObject({ reason: 'missing_sdk' });
      await expect(
        validateAIConnection(
          definition.id,
          { ...environment(definition), [`${definition.prefix}_API_KEY`]: undefined },
          { factory },
        ),
      ).rejects.toMatchObject({ reason: 'missing_configuration' });
      await expect(
        validateAIConnection(
          definition.id,
          { ...environment(definition), [`${definition.prefix}_MODEL_ID`]: undefined },
          { factory },
        ),
      ).rejects.toMatchObject({ reason: 'missing_configuration' });
      for (const address of [
        'http://plain.example.invalid/v1',
        'https://user:password@example.invalid/v1',
        'https://example.invalid/v1?key=hidden',
      ])
        await expect(
          validateAIConnection(
            definition.id,
            { ...environment(definition), [`${definition.prefix}_BASE_URL`]: address },
            { factory },
          ),
        ).rejects.toMatchObject({ reason: 'invalid_configuration' });
    }
    await expect(
      validateAIConnection(
        'ai-anthropic',
        { ...environment(AI_CONNECTIONS[4]), AI_ANTHROPIC_MAX_TOKENS: undefined },
        { factory },
      ),
    ).rejects.toMatchObject({ reason: 'missing_configuration' });
    await expect(
      aiModuleOptionsFromEnvironment({ AI_OPENAI_ENABLED: 'true' }),
    ).rejects.toMatchObject({ reason: 'missing_configuration' });
    await expect(
      validateAIConnection('ai-openai', { AI_OPENAI_ENABLED: 'false' }, { factory }),
    ).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(inspectAIConnections({}).every((row) => row.status === 'disabled')).toBe(true);
    expect(inspectAIConnections({ AI_OPENAI_ENABLED: 'true' })[0]).toMatchObject({
      status: 'missing',
      missing: ['AI_OPENAI_API_KEY', 'AI_OPENAI_MODEL_ID'],
    });
  });
  it('rejects aliases to unknown connections and preserves disabled targets instead of selecting a default', async () => {
    await expect(
      aiModuleOptionsFromEnvironment({}, { routes: { 'synthetic.review': 'connection.unknown' } }),
    ).rejects.toMatchObject({ reason: 'unknown_route' });
    const options = await aiModuleOptionsFromEnvironment(
      {},
      { routes: { 'synthetic.review': 'connection.openai' } },
    );
    const configs = new AIConfigService(undefined, options.configSources);
    await expect(
      configs.getScenarioConfig('synthetic.review', { allowDefault: true }),
    ).rejects.toMatchObject({ reason: 'disabled' });
    await expect(
      configs.getScenarioConfig('synthetic.undeclared', { allowDefault: true }),
    ).rejects.toMatchObject({ reason: 'unknown_route' });
  });
});

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('encrypted AI connections PostgreSQL, HTTP and actual Nest composition', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>, fetch: ReturnType<typeof vi.spyOn>;
  const seenConfigs: AIModelConfig[] = [],
    seenRequests: NativeChatRequest[] = [];
  const factory: NativeModelFactory = async (config) => {
    seenConfigs.push({ ...config });
    return {
      async chat(input, signal) {
        expect(signal).toBeInstanceOf(AbortSignal);
        seenRequests.push(input);
        return {
          content: 'Synthetic completion',
          usage: { input: 3, output: 2, total: 5 },
          model: config.modelId,
        };
      },
      async stream(_input, signal) {
        expect(signal).toBeInstanceOf(AbortSignal);
        return (async function* () {
          yield { content: 'Synthetic stream', usage: { input: 4, output: 2, total: 6 } };
        })();
      },
    };
  };
  const get = (id: string) =>
    request(f.app.getHttpServer())
      .get(`/api/management/connection-settings/${id}`)
      .set('Authorization', `Bearer ${f.admin.token}`);
  const put = (id: string, body: object, token?: string) =>
    request(f.app.getHttpServer())
      .put(`/api/management/connection-settings/${id}`)
      .set('Authorization', `Bearer ${token ?? f.admin.token}`)
      .set('Origin', origin)
      .send(body);
  beforeAll(async () => {
    fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Remote model calls are forbidden'));
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, origin, {
      nativeAI: { factory, routes: { 'synthetic.review': 'connection.openai' } },
    });
  });
  afterAll(async () => {
    try {
      await f?.close();
    } finally {
      fetch?.mockRestore();
    }
  });
  it('keeps all connections disabled and rejects unknown or disabled routes before legacy database fallback', async () => {
    const configs = f.app.get(AIConfigService),
      client = f.app.get(NativeAIClient);
    expect(configs.getSources().map((source) => source.id)).toEqual([
      'runtime-connections',
      'database',
    ]);
    const database = vi.spyOn(f.database, 'model');
    try {
      for (const route of ['connection.openai', 'unknown.business.scenario', 'default'])
        await expect(
          client.chat(
            route,
            { messages: [{ role: 'user', content: 'Synthetic input' }] },
            { allowDefault: true },
          ),
        ).rejects.toThrow('AI connection is unavailable');
      expect(database.mock.calls.some(([name]) => name === 'aiModels')).toBe(false);
    } finally {
      database.mockRestore();
    }
    expect(seenConfigs).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('protects new profile writes and validates enabled parameters before encrypted persistence', async () => {
    await put('ai-openai', { expectedRevision: 0, values: { AI_OPENAI_ENABLED: 'true' } }).expect(
      400,
    );
    await put('ai-openai', { expectedRevision: 0, values: { AI_OPENAI_API_KEY: secret } }).expect(
      400,
    );
    await put(
      'ai-openai',
      {
        expectedRevision: 0,
        values: values(AI_CONNECTIONS[0]),
        secrets: { AI_OPENAI_API_KEY: { action: 'replace', value: secret } },
      },
      f.reader.token,
    ).expect(403);
    expect(
      await f.database.model('config').count({ where: { scope: CONNECTION_SETTINGS_SCOPE } }),
    ).toBe(0);
  });
  it('saves six encrypted profiles without activating them or leaking secrets in HTTP, audit or public integrations', async () => {
    const responses: unknown[] = [];
    for (const definition of AI_CONNECTIONS) {
      const saved = await put(definition.id, {
        expectedRevision: 0,
        values: values(definition),
        secrets: { [`${definition.prefix}_API_KEY`]: { action: 'replace', value: secret } },
      }).expect(200);
      responses.push(saved.body);
      expect(saved.body).toMatchObject({
        storedRevision: 1,
        appliedRevision: 0,
        pendingRestart: true,
        externalRequests: false,
      });
      const field = saved.body.fields.find(
        (field: { key: string }) => field.key === `${definition.prefix}_API_KEY`,
      );
      expect(field).toMatchObject({ configured: true, source: 'saved', type: 'secret' });
      expect(field).not.toHaveProperty('value');
    }
    const stored = (await f.database
      .model('config')
      .findMany({ where: { scope: CONNECTION_SETTINGS_SCOPE } })) as Array<{ value: string }>;
    expect(stored).toHaveLength(6);
    expect(stored.every((row) => row.value.startsWith('v2.'))).toBe(true);
    const audit = await f.database
      .model('operationLogs')
      .findMany({ where: { module: 'runtime-settings' } });
    const publicView = (
      await request(f.app.getHttpServer()).get('/api/site/public/integrations').expect(200)
    ).body;
    expect(JSON.stringify([stored, audit, responses, publicView])).not.toContain(secret);
    expect(JSON.stringify(publicView)).not.toContain('ai-openai');
    await expect(
      f.app
        .get(NativeAIClient)
        .chat('connection.openai', { messages: [{ role: 'user', content: 'Synthetic input' }] }),
    ).rejects.toMatchObject({ reason: 'disabled' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reconstructs saved connections on restart and injects NativeAIClient through the shared retry/usage wrapper', async () => {
    await f.restart();
    const client = f.app.get(NativeAIClient),
      configs = f.app.get(AIConfigService),
      wrapper = f.app.get(AICallWrapper);
    const calls = vi.spyOn(wrapper, 'callWithRetry'),
      streams = vi.spyOn(wrapper, 'callWithStream'),
      observer = { onSuccess: vi.fn() };
    f.app.get(AICallObserverRegistry).register(observer);
    try {
      for (const definition of AI_CONNECTIONS) {
        expect((await get(definition.id).expect(200)).body).toMatchObject({
          storedRevision: 1,
          appliedRevision: 1,
          pendingRestart: false,
        });
        const resolved = await configs.getScenarioConfig(definition.route, { allowDefault: false });
        expect(resolved).toMatchObject(aiConnectionConfig(definition, environment(definition)));
        const response = await client.chat(
          definition.route,
          { messages: [{ role: 'user', content: 'Synthetic input' }] },
          { maxAttempts: 1 },
        );
        expect(response).toMatchObject({
          content: 'Synthetic completion',
          usage: { input: 3, output: 2, total: 5 },
          config: { modelRecordId: definition.id, providerId: definition.provider },
        });
      }
      const aliased = await client.chat(
        'synthetic.review',
        { messages: [{ role: 'user', content: 'Synthetic aliased input' }] },
        { maxAttempts: 1 },
      );
      expect(aliased.config).toMatchObject({ modelRecordId: 'ai-openai', providerId: 'openai' });
      expect(calls).toHaveBeenCalledTimes(7);
      expect(seenRequests.every((input) => input.maxTokens === 128)).toBe(true);
      expect(
        seenConfigs.every((config) => config.apiKey === secret && config.timeoutMs === 2500),
      ).toBe(true);
      const streamed = await client.stream('connection.openai', {
        messages: [{ role: 'user', content: 'Synthetic stream input' }],
      });
      expect(streamed).toMatchObject({
        content: 'Synthetic stream',
        usage: { input: 4, output: 2, total: 6 },
        chunkCount: 1,
      });
      expect(streams).toHaveBeenCalledOnce();
      expect(observer.onSuccess).toHaveBeenCalledTimes(8);
      expect(observer.onSuccess.mock.calls.every(([event]) => event.result === undefined)).toBe(
        true,
      );
      expect(JSON.stringify(observer.onSuccess.mock.calls)).not.toContain(secret);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
      streams.mockRestore();
    }
  });
  it('keeps applied settings stable until restart and then rejects a disabled connection despite prior cached resolution', async () => {
    await put('ai-openai', { expectedRevision: 1, values: { AI_OPENAI_ENABLED: 'false' } }).expect(
      200,
    );
    expect((await f.app.get(AIConfigService).getScenarioConfig('connection.openai')).apiKey).toBe(
      secret,
    );
    await f.restart();
    const count = seenConfigs.length,
      configs = f.app.get(AIConfigService),
      database = vi.spyOn(f.database, 'model');
    try {
      await expect(
        f.app
          .get(NativeAIClient)
          .chat(
            'connection.openai',
            { messages: [{ role: 'user', content: 'Synthetic input' }] },
            { allowDefault: true },
          ),
      ).rejects.toMatchObject({ reason: 'disabled' });
      await expect(
        f.app
          .get(NativeAIClient)
          .chat(
            'synthetic.review',
            { messages: [{ role: 'user', content: 'Synthetic input' }] },
            { allowDefault: true },
          ),
      ).rejects.toMatchObject({ reason: 'disabled' });
      await expect(
        configs.getScenarioConfig('unrouted.consumer.scene', { allowDefault: true }),
      ).rejects.toMatchObject({ reason: 'unknown_route' });
      expect(database.mock.calls.some(([name]) => name === 'aiModels')).toBe(false);
    } finally {
      database.mockRestore();
    }
    expect(seenConfigs).toHaveLength(count);
    expect(fetch).not.toHaveBeenCalled();
    const metadata = (
      await request(f.app.getHttpServer())
        .get('/api/management/connections')
        .set('Authorization', `Bearer ${f.admin.token}`)
        .expect(200)
    ).body;
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });
});
