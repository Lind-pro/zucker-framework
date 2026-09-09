import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { AIConfigService } from '../config.service';
import type { AIConfigSource } from '../config-source';
import { DatabaseAIConfigSource } from './database-config.source';
import { EnvironmentAIConfigSource } from './environment-config.source';
import { RemoteAIConfigSource } from './remote-config.source';
import { StaticAIConfigSource } from './static-config.source';

const config = (modelId: string) => ({
  apiKey: `key-${modelId}`,
  modelId,
  providerId: 'openai',
});

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn().mockResolvedValue(body),
});

describe('AI configuration sources', () => {
  it('loads scenario-specific environment values before global defaults', async () => {
    const source = new EnvironmentAIConfigSource({
      env: {
        AI_MODEL: 'global-model',
        AI_PROVIDER: 'OpenAI',
        AI_SOURCE_BLUEPRINT_MODEL: 'blueprint-model',
        AI_SOURCE_BLUEPRINT_TEMPERATURE: '0.25',
        AI_SOURCE_BLUEPRINT_MAX_TOKENS: '8192',
      },
    });

    await expect(source.getScenarioConfig('source-blueprint')).resolves.toMatchObject({
      modelId: 'blueprint-model',
      providerId: 'openai',
      temperature: 0.25,
      maxTokens: 8192,
    });
    await expect(source.getScenarioConfig('source-review')).resolves.toMatchObject({
      modelId: 'global-model',
      providerId: 'openai',
    });
  });

  it('selects the highest-priority source and caches the resolved config', async () => {
    const low = new StaticAIConfigSource({
      id: 'low',
      priority: 10,
      defaultConfig: config('low-model'),
    });
    const high = new StaticAIConfigSource({
      id: 'high',
      priority: 50,
      defaultConfig: config('high-model'),
    });
    const spy = vi.spyOn(high, 'getScenarioConfig');
    const service = new AIConfigService(undefined, [low, high]);

    await expect(service.getScenarioConfig('source-plan')).resolves.toMatchObject({
      modelId: 'high-model',
    });
    await service.getScenarioConfig('source-plan');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(service.getSources().map((source) => source.id)).toEqual(['high', 'low']);
  });

  it('continues after a recoverable source failure', async () => {
    const failing: AIConfigSource = {
      id: 'remote',
      priority: 100,
      failureMode: 'continue',
      getScenarioConfig: vi.fn().mockRejectedValue(new Error('API unavailable')),
    };
    const fallback = new StaticAIConfigSource({ defaultConfig: config('fallback-model') });
    const service = new AIConfigService(undefined, [fallback, failing]);

    await expect(service.getScenarioConfig('source-file')).resolves.toMatchObject({
      modelId: 'fallback-model',
    });
  });

  it('stops after a fail-closed source error', async () => {
    const failing: AIConfigSource = {
      id: 'vault',
      priority: 200,
      failureMode: 'throw',
      getScenarioConfig: vi.fn().mockRejectedValue(new Error('vault unavailable')),
    };
    const fallback = new StaticAIConfigSource({ defaultConfig: config('fallback-model') });
    const service = new AIConfigService(undefined, [fallback, failing]);

    await expect(service.getScenarioConfig('source-file')).rejects.toThrow('vault unavailable');
  });

  it('supports runtime source replacement and cache invalidation', async () => {
    const service = new AIConfigService(undefined, [
      new StaticAIConfigSource({ id: 'runtime', defaultConfig: config('first-model') }),
    ]);
    await expect(service.getScenarioConfig('source-file')).resolves.toMatchObject({
      modelId: 'first-model',
    });

    service.registerSource(
      new StaticAIConfigSource({ id: 'runtime', defaultConfig: config('second-model') }),
    );
    await expect(service.getScenarioConfig('source-file')).resolves.toMatchObject({
      modelId: 'second-model',
    });
    expect(service.unregisterSource('runtime')).toBe(true);
    expect(service.unregisterSource('missing')).toBe(false);
  });

  it('loads database configuration from a configurable model name', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'model-1',
      name: 'Code model',
      provider: 'DeepSeek',
      modelId: 'deepseek-chat',
      apiKey: 'encrypted-key',
      baseUrl: 'https://example.test/v1',
      isEnabled: true,
      scenarios: ['source-file'],
    });
    const db = {
      model: vi.fn().mockReturnValue({ findFirst, findMany: vi.fn().mockResolvedValue([]) }),
      $transaction: vi.fn(),
    } as unknown as DatabaseAdapter;
    const source = new DatabaseAIConfigSource(db, { modelName: 'modelRegistry' });

    await expect(source.getScenarioConfig('source-file')).resolves.toMatchObject({
      modelId: 'deepseek-chat',
      providerId: 'deepseek',
      baseURL: 'https://example.test/v1',
    });
    expect(db.model).toHaveBeenCalledWith('modelRegistry');
  });

  it('loads and unwraps remote API configuration with dynamic headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        result: {
          provider: 'OpenAI',
          model: 'gpt-code',
          apiKey: 'remote-key',
          temperature: 0.35,
        },
      }),
    );
    const source = new RemoteAIConfigSource({
      baseUrl: 'https://config.example.test/ai',
      headers: () => ({ Authorization: 'Bearer internal-token' }),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(source.getScenarioConfig('source/file')).resolves.toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-code',
      apiKey: 'remote-key',
      temperature: 0.35,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://config.example.test/ai/source%2Ffile',
      expect.objectContaining({
        headers: { Authorization: 'Bearer internal-token' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('treats remote 404 as an unconfigured scenario', async () => {
    const source = new RemoteAIConfigSource({
      baseUrl: 'https://config.example.test/ai',
      fetcher: vi.fn().mockResolvedValue(response(404, {})) as unknown as typeof fetch,
    });

    await expect(source.getScenarioConfig('missing')).resolves.toBeNull();
  });

  it('merges scenario lists and keeps list failures non-blocking', async () => {
    const first = new StaticAIConfigSource({
      scenarios: { review: config('review-model') },
    });
    const duplicate = new StaticAIConfigSource({
      id: 'duplicate',
      scenarios: { review: config('review-model') },
    });
    const failing: AIConfigSource = {
      id: 'failing-list',
      failureMode: 'throw',
      priority: 500,
      getScenarioConfig: vi.fn().mockResolvedValue(null),
      getScenarios: vi.fn().mockRejectedValue(new Error('list unavailable')),
    };
    const service = new AIConfigService(undefined, [first, duplicate, failing]);

    await expect(service.getScenarios()).resolves.toEqual([
      expect.objectContaining({ id: 'review', model: 'review-model' }),
    ]);
  });
});
