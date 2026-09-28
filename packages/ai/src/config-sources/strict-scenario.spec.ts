import { describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { AIConfigService } from '../config.service';
import { StaticAIConfigSource } from './static-config.source';
import { EnvironmentAIConfigSource } from './environment-config.source';
import { DatabaseAIConfigSource } from './database-config.source';
import { RemoteAIConfigSource } from './remote-config.source';

const config = { modelId: 'configured-model', apiKey: 'synthetic' };
const strict = { allowDefault: false };
describe('strict scenario resolution', () => {
  it('isolates permissive and strict caches and invalidates both', async () => {
    const source = new StaticAIConfigSource({ defaultConfig: config, scenarios: { chat: config } });
    const spy = vi.spyOn(source, 'getScenarioConfig');
    const service = new AIConfigService(undefined, [source]);
    await service.getScenarioConfig('embed');
    await expect(service.getScenarioConfig('embed', strict)).rejects.toThrow();
    await service.getScenarioConfig('chat');
    await service.getScenarioConfig('chat', strict);
    await service.getScenarioConfig('chat', strict);
    expect(spy).toHaveBeenCalledTimes(4);
    service.invalidateScenario('chat');
    await service.getScenarioConfig('chat');
    await service.getScenarioConfig('chat', strict);
    expect(spy).toHaveBeenCalledTimes(6);
    await expect(source.getScenarioConfig('toString', strict)).resolves.toBeNull();
  });
  it('requires an environment-scoped model but permits shared credentials', async () => {
    const source = new EnvironmentAIConfigSource({ env: { AI_MODEL_ID: 'chat', AI_API_KEY: 'synthetic', AI_EMBED_MODEL: 'vector' } });
    expect(await source.getScenarioConfig('embed', strict)).toMatchObject({ modelId: 'vector', apiKey: 'synthetic' });
    expect(await source.getScenarioConfig('missing', strict)).toBeNull();
  });
  it('never queries the database default on strict misses', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const source = new DatabaseAIConfigSource({ model: () => ({ findFirst }) } as unknown as DatabaseAdapter);
    expect(await source.getScenarioConfig('embed', strict)).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    await source.getScenarioConfig('embed');
    expect(findFirst).toHaveBeenCalledTimes(3);
  });
  it('requires remote scenario provenance even with a transform', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: config })));
    const transform = vi.fn().mockReturnValue(config);
    const source = new RemoteAIConfigSource({ baseUrl: 'https://synthetic.test', fetcher, transform });
    expect(await source.getScenarioConfig('embed', strict)).toBeNull();
    expect(transform).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][0]).toBe('https://synthetic.test/embed?allowDefault=false');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { ...config, scenario: 'embed' } })));
    expect(await source.getScenarioConfig('embed', strict)).toEqual(config);
    expect(transform).toHaveBeenCalledWith(expect.anything(), 'embed', strict);
  });
  it('preserves valid remote identity and rejects malformed identity fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...config, scenario: 'embed', modelRecordId: 'remote-record' })));
    const source = new RemoteAIConfigSource({ baseUrl: 'https://synthetic.test', fetcher });
    expect(await source.getScenarioConfig('embed', strict)).toMatchObject({ modelRecordId: 'remote-record' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...config, scenario: 'embed', modelRecordId: 42 })));
    await expect(source.getScenarioConfig('embed', strict)).rejects.toThrow('modelRecordId');
  });
  it('continues across sources without permitting fallback in a lower source', async () => {
    const service = new AIConfigService(undefined, [
      new EnvironmentAIConfigSource({ env: { AI_MODEL: 'chat' } }),
      new StaticAIConfigSource({ defaultConfig: config, scenarios: { embed: config } }),
    ]);
    expect(await service.getScenarioConfig('embed', strict)).toEqual(config);
    await expect(service.getScenarioConfig('missing', strict)).rejects.toThrow();
  });
});
