import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DATABASE_ADAPTER,
  type DatabaseAdapter,
  NotFoundException,
  ValidationException,
} from '@zucker-framework/core';
import type { AIModelConfig, AIScenario } from './ai-provider.interface';
import { AI_CONFIG_SOURCES, type AIConfigSource, type ScenarioConfigOptions } from './config-source';
import { DatabaseAIConfigSource } from './config-sources/database-config.source';

const MAX_CACHE_SIZE = 200;

export type ApiKeyDecryptor = (encryptedKey: string) => string | Promise<string>;

@Injectable()
export class AIConfigService {
  private readonly logger = new Logger(AIConfigService.name);
  private readonly cache = new Map<string, { config: AIModelConfig; cachedAt: number; ttl: number }>();
  private readonly sources: AIConfigSource[];
  private cacheTtl = 60_000;
  // A fallback taken because a source failed is cached only briefly: long enough that an
  // outage does not cost every AI call that source's timeout, short enough to recover quickly.
  private fallbackCacheTtl = 5_000;
  private apiKeyDecryptor: ApiKeyDecryptor | null = null;

  constructor(
    @Inject(DATABASE_ADAPTER) @Optional() db?: DatabaseAdapter,
    @Inject(AI_CONFIG_SOURCES) @Optional() configuredSources: AIConfigSource[] = [],
  ) {
    this.sources = [...configuredSources];
    if (db && !this.sources.some((source) => source instanceof DatabaseAIConfigSource)) {
      this.sources.push(new DatabaseAIConfigSource(db));
    }
    this.sortSources();
  }

  setCacheTtl(ttlMs: number): void {
    if (ttlMs > 0 && Number.isFinite(ttlMs)) this.cacheTtl = ttlMs;
  }

  /** TTL for a config chosen after a source error (default 5 s); `0` disables caching it. */
  setFallbackCacheTtl(ttlMs: number): void {
    if (ttlMs >= 0 && Number.isFinite(ttlMs)) this.fallbackCacheTtl = ttlMs;
  }

  /** Register before the first lookup; cached configs contain the decrypted key. */
  setApiKeyDecryptor(fn: ApiKeyDecryptor | null): void {
    this.apiKeyDecryptor = fn;
  }

  /** Replace sources with the same id and invalidate all resolved scenario configs. */
  registerSource(source: AIConfigSource): void {
    const index = this.sources.findIndex((item) => item.id === source.id);
    if (index >= 0) this.sources.splice(index, 1, source);
    else this.sources.push(source);
    this.sortSources();
    this.clearCache();
  }

  unregisterSource(sourceId: string): boolean {
    const index = this.sources.findIndex((source) => source.id === sourceId);
    if (index < 0) return false;
    this.sources.splice(index, 1);
    this.clearCache();
    return true;
  }

  getSources(): readonly AIConfigSource[] {
    return this.sources;
  }

  async getScenarioConfig(scenario: string, options: ScenarioConfigOptions = {}): Promise<AIModelConfig> {
    if (!scenario || typeof scenario !== 'string') {
      throw new ValidationException({ scenario: ['场景名称不能为空'] }, '场景名称不能为空');
    }
    const cacheKey = JSON.stringify([scenario, options.allowDefault !== false]);
    const cached = this.cache.get(cacheKey);
    // Return a copy: callers must not be able to mutate the cached (decrypted) config.
    if (cached && Date.now() - cached.cachedAt < cached.ttl) return { ...cached.config };

    // Pass 1 asks every source for an explicit scenario mapping; pass 2 (only when defaults
    // are allowed) asks for defaults. A higher-priority source's default model must not hide
    // a lower-priority source's explicit mapping for this scenario.
    const passes: ScenarioConfigOptions[] =
      options.allowDefault === false
        ? [{ ...options, allowDefault: false }]
        : [{ ...options, allowDefault: false }, { ...options, allowDefault: true }];
    const failedSources = new Set<string>();
    for (const passOptions of passes) {
      for (const source of this.sources) {
        if (failedSources.has(source.id)) continue;
        let config: AIModelConfig | null;
        try {
          config = await source.getScenarioConfig(scenario, passOptions);
        } catch (error) {
          if (source.failureMode === 'throw') throw error;
          failedSources.add(source.id);
          this.logger.warn(
            `AI 配置源 '${source.id}' 读取失败，继续尝试下一个来源: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (!config) continue;
        const resolved = await this.decryptConfig(config);
        // A fallback chosen because a source failed is cached only for the short fallback TTL,
        // after which the next call retries the failed source.
        if (failedSources.size === 0) this.setCache(cacheKey, resolved, this.cacheTtl);
        else if (this.fallbackCacheTtl > 0) this.setCache(cacheKey, resolved, Math.min(this.fallbackCacheTtl, this.cacheTtl));
        this.logger.log(
          `AI 配置已加载 [${scenario}] source=${source.id}: ${resolved.providerId ?? 'unknown'} - ${resolved.modelId}`,
        );
        return { ...resolved };
      }
    }

    const sourceIds = this.sources.map((source) => source.id).join(', ') || '(无)';
    throw new NotFoundException(`AI 模型未配置 (scenario=${scenario}, sources=${sourceIds})`);
  }

  async getScenarios(): Promise<AIScenario[]> {
    const scenarios: AIScenario[] = [];
    const seen = new Set<string>();
    for (const source of this.sources) {
      if (!source.getScenarios) continue;
      let sourceScenarios: AIScenario[];
      try {
        sourceScenarios = await source.getScenarios();
      } catch (error) {
        this.logger.warn(
          `AI 配置源 '${source.id}' 场景列表读取失败: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const scenario of sourceScenarios) {
        const key = `${scenario.id}:${scenario.provider}:${scenario.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scenarios.push(scenario);
      }
    }
    return scenarios;
  }

  clearCache(): void {
    this.cache.clear();
  }

  invalidateScenario(scenario: string): void {
    this.cache.delete(JSON.stringify([scenario, true]));
    this.cache.delete(JSON.stringify([scenario, false]));
  }

  private async decryptConfig(config: AIModelConfig): Promise<AIModelConfig> {
    if (!this.apiKeyDecryptor || !config.apiKey) return { ...config };
    return {
      ...config,
      apiKey: await Promise.resolve(this.apiKeyDecryptor(config.apiKey)),
    };
  }

  private setCache(scenario: string, config: AIModelConfig, ttl: number): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.findOldestCacheKey();
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(scenario, { config, cachedAt: Date.now(), ttl });
  }

  private sortSources(): void {
    this.sources.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  }

  private findOldestCacheKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, value] of this.cache) {
      if (value.cachedAt < oldestTime) {
        oldestTime = value.cachedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
