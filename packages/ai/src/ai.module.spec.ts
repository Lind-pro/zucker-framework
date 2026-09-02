import { describe, expect, it } from 'vitest';
import type { FactoryProvider } from '@nestjs/common';
import { AI_CONFIG_SOURCES } from './config-source';
import { StaticAIConfigSource } from './config-sources/static-config.source';
import { ZuckerAIModule } from './ai.module';

describe('ZuckerAIModule configuration sources', () => {
  it('registers and exports configured sources', () => {
    const source = new StaticAIConfigSource({
      defaultConfig: {
        apiKey: 'test-key',
        modelId: 'test-model',
        providerId: 'openai',
      },
    });
    const module = ZuckerAIModule.forRoot({ configSources: [source] });
    const provider = module.providers?.find(
      (item): item is FactoryProvider =>
        typeof item === 'object' && item !== null && 'provide' in item && item.provide === AI_CONFIG_SOURCES,
    );

    expect(provider).toBeDefined();
    expect(provider?.useFactory({ configSources: [source] })).toEqual([source]);
    expect(module.exports).toContain(AI_CONFIG_SOURCES);
  });
});
