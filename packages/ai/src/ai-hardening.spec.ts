// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { classifyAIError } from './ai-call-errors';
import { AICallWrapper } from './call-wrapper';
import { AIConfigService } from './config.service';
import { EnvironmentAIConfigSource } from './config-sources/environment-config.source';
import { StaticAIConfigSource } from './config-sources/static-config.source';
import { CostTracker } from './cost-tracker';
import { MediaGenerationService } from './media-generation.service';
import { MediaProviderManager } from './media-provider-manager';
import { MediaTaskStatus, MediaType, type MediaProvider } from './media.interface';
import { sanitizeAIObserverError } from './observer-sanitizer';
import { PersistedCostTracker } from './observers/cost-persister';
import { PromptManager } from './prompt-manager';
import { ProviderHttpError } from './provider-http-error';
import { KlingProvider } from './providers/kling.provider';
import type { AIModelConfig } from './ai-provider.interface';
import type { DatabaseAdapter } from '@zucker-framework/core';

const cfg = (modelId: string): AIModelConfig => ({ apiKey: 'k', modelId });

describe('media generation retries and cost (M4/M5)', () => {
  const setup = (provider: Partial<MediaProvider>) => {
    const manager = new MediaProviderManager();
    manager.register({
      id: 'p',
      name: 'P',
      supportedTypes: [MediaType.IMAGE, MediaType.VIDEO],
      getModels: () => [{ id: 'm', name: 'm', mediaType: MediaType.VIDEO }],
      generate: vi.fn(),
      ...provider,
    } as MediaProvider);
    const tracker = new CostTracker();
    const record = vi.spyOn(tracker, 'record');
    return { service: new MediaGenerationService(manager, new AICallWrapper(), tracker), record };
  };

  it('submits a billable generation only once by default', async () => {
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError('P', 502, 'bad gateway'));
    const { service } = setup({ generate });
    await expect(service.generateImage('x', 'k')).rejects.toThrow('502');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('records video cost once when the task first completes', async () => {
    const getTaskStatus = vi.fn().mockResolvedValue({
      taskId: 't1',
      status: MediaTaskStatus.COMPLETED,
      provider: 'p',
      result: { mediaType: MediaType.VIDEO, cost: 0.4, provider: 'p', model: 'm', durationMs: 0 },
    });
    const { service, record } = setup({ getTaskStatus });
    await service.getTaskStatus('p', 't1', 'k', undefined, { userId: 'u1' });
    await service.getTaskStatus('p', 't1', 'k');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ cost: 0.4, userId: 'u1', scenario: 'media:video' });
  });

  it('classifies provider client errors and exhausted quota as non-retryable', () => {
    expect(classifyAIError(new ProviderHttpError('Kling', 400, 'bad')).retryable).toBe(false);
    expect(classifyAIError(new ProviderHttpError('Kling', 503, 'busy')).retryable).toBe(true);
    const quota = Object.assign(new Error('insufficient_quota: You exceeded your current quota'), {
      status: 429,
    });
    expect(classifyAIError(quota).retryable).toBe(false);
  });
});

describe('Kling task polling (M17)', () => {
  it('treats an API-level error envelope as a terminal failure and encodes the task id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ code: 1201, message: 'task not found' })));
    try {
      const result = await new KlingProvider().getTaskStatus('a/../b', { apiKey: 'k', modelId: '' });
      expect(result).toMatchObject({ status: MediaTaskStatus.FAILED, error: 'task not found' });
      expect(String(fetchMock.mock.calls[0][0])).toContain('a%2F..%2Fb');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('scenario routing (M6)', () => {
  it('prefers a lower-priority explicit mapping over a higher-priority default', async () => {
    const env = new EnvironmentAIConfigSource({ env: { AI_MODEL: 'global', AI_API_KEY: 'g' } });
    const db = new StaticAIConfigSource({ id: 'db', priority: 100, scenarios: { review: cfg('mapped') } });
    const service = new AIConfigService(undefined, [env, db]);
    await expect(service.getScenarioConfig('review')).resolves.toMatchObject({ modelId: 'mapped' });
    await expect(service.getScenarioConfig('other')).resolves.toMatchObject({ modelId: 'global' });
  });

  it('does not cache a fallback chosen after a source failure', async () => {
    let fail = true;
    const flaky = {
      id: 'remote',
      priority: 200,
      failureMode: 'continue' as const,
      getScenarioConfig: vi.fn(async () => {
        if (fail) throw new Error('down');
        return cfg('remote-model');
      }),
    };
    const fallback = new StaticAIConfigSource({ defaultConfig: cfg('fallback') });
    const service = new AIConfigService(undefined, [flaky, fallback]);
    await expect(service.getScenarioConfig('s')).resolves.toMatchObject({ modelId: 'fallback' });
    fail = false;
    await expect(service.getScenarioConfig('s')).resolves.toMatchObject({ modelId: 'remote-model' });
  });

  it('does not inherit the global key for a scoped model on another endpoint', async () => {
    const source = new EnvironmentAIConfigSource({
      env: {
        AI_MODEL: 'g',
        AI_API_KEY: 'global-key',
        AI_EMBED_MODEL: 'e',
        AI_EMBED_BASE_URL: 'https://other.test/v1',
      },
    });
    await expect(source.getScenarioConfig('embed')).resolves.toMatchObject({ apiKey: '' });
  });

  it('returns copies so callers cannot mutate the cached config', async () => {
    const service = new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: cfg('m') })]);
    const first = await service.getScenarioConfig('s');
    first.modelId = 'mutated';
    await expect(service.getScenarioConfig('s')).resolves.toMatchObject({ modelId: 'm' });
  });
});

describe('cost persister running statistics (M15)', () => {
  it('flushes large aggregates without spreading sample arrays', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const tracker = new PersistedCostTracker({ persist }, { skipMissingModelRecordId: false });
    for (let i = 0; i < 200_000; i += 1) {
      tracker.record({
        timestamp: 0,
        provider: 'p',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        duration: (i % 100) + 1,
      });
    }
    await tracker.flush();
    expect(persist.mock.calls[0][0][0]).toMatchObject({
      requestCount: 200_000,
      minResponseTime: 1,
      maxResponseTime: 100,
    });
  });
});

describe('observer error redaction (L2)', () => {
  it('removes credentials echoed in provider errors', () => {
    const error = sanitizeAIObserverError(
      new Error('401 Incorrect API key provided: sk-abcdefghijklmnop; Authorization: Bearer eyJabc.def.ghi api_key=secret123'),
    );
    expect(error.message).not.toMatch(/sk-abcdefgh|eyJabc|secret123/);
    expect(error.message).toContain('[REDACTED]');
  });
});

describe('prompt template persistence (L6)', () => {
  it('surfaces database failures instead of reporting a cache-only success', async () => {
    const db = {
      model: () => ({
        findUnique: vi.fn().mockRejectedValue(new Error('db down')),
      }),
    } as unknown as DatabaseAdapter;
    const manager = new PromptManager(db);
    await expect(
      manager.saveTemplate({ id: 't', name: 't', content: 'x' } as never),
    ).rejects.toThrow('db down');
  });
});
