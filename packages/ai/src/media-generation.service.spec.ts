import { AICallTimeoutError } from './ai-call-errors';
import { AICallWrapper } from './call-wrapper';
import { CostTracker } from './cost-tracker';
import { MediaGenerationService } from './media-generation.service';
import { MediaProviderManager } from './media-provider-manager';
import {
  MediaType,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaProvider,
} from './media.interface';

const imageResult = (): MediaGenerationResult => ({
  url: 'https://example.com/image.png',
  mediaType: MediaType.IMAGE,
  cost: 0.01,
  provider: 'test-image',
  model: 'test-model',
  durationMs: 1,
});

describe('MediaGenerationService cancellation', () => {
  const createService = (generate: MediaProvider['generate']) => {
    const manager = new MediaProviderManager();
    manager.register({
      id: 'test-image',
      name: 'Test Image',
      supportedTypes: [MediaType.IMAGE],
      generate,
      getModels: () => [{ id: 'test-model', name: 'Test', mediaType: MediaType.IMAGE }],
    });
    return new MediaGenerationService(manager, new AICallWrapper(), new CostTracker());
  };

  it('does not impose a default image timeout and still passes an attempt signal', async () => {
    let receivedConfig: MediaGenerationConfig | undefined;
    const service = createService(async (_prompt, config) => {
      receivedConfig = config;
      return imageResult();
    });

    await expect(service.generateImage('draw', 'api-key')).resolves.toMatchObject({
      provider: 'test-image',
    });
    expect(receivedConfig?.timeoutMs).toBeUndefined();
    expect(receivedConfig?.signal).toBeInstanceOf(AbortSignal);
    expect(receivedConfig?.signal?.aborted).toBe(false);
  });

  it('aborts an explicit timeout at the provider and does not duplicate the call', async () => {
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const service = createService(async (_prompt, config) => {
      calls += 1;
      receivedSignal = config.signal;
      return new Promise<MediaGenerationResult>(() => undefined);
    });

    await expect(
      service.generateImage('draw', 'api-key', { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(AICallTimeoutError);
    expect(calls).toBe(1);
    expect(receivedSignal?.aborted).toBe(true);
  });
});
