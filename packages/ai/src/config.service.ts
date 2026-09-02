import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DATABASE_ADAPTER,
  type DatabaseAdapter,
  NotFoundException,
  ValidationException,
} from '@zucker/core';
import type { AIModelConfig, AIScenario } from './ai-provider.interface';
import { AI_CONFIG_SOURCES, type AIConfigSource } from './config-source';
import { DatabaseAIConfigSource } from './config-sources/database-config.source';

const MAX_CACHE_SIZE = 200;

export type ApiKeyDecryptor = (encryptedKey: string) => string | Promise<string>;

@Injectable()
export class AIConfigService {
  private readonly logger = new Logger(AIConfigService.name);
  private readonly cache = new Map<string, { config: AIModelConfig; cachedAt: number }>();
  private readonly sources: AIConfigSource[];
  private cacheTtl = 60_000;
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

  async getScenarioConfig(scenario: string): Promise<AIModelConfig> {
    if (!scenario || typeof scenario !== 'string') {
      throw new ValidationException({ scenario: ['场景名称不能为空'] }, '场景名称不能为空');
    }
    const cached = this.cache.get(scenario);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) return cached.config;

    for (const source of this.sources) {
      let config: AIModelConfig | null;
      try {
        config = await source.getScenarioConfig(scenario);
      } catch (error) {
        if (source.failureMode === 'throw') throw error;
        this.logger.warn(
          `AI 配置源 '${source.id}' 读取失败，继续尝试下一个来源: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!config) continue;
      const resolved = await this.decryptConfig(config);
      this.setCache(scenario, resolved);
      this.logger.log(
        `AI 配置已加载 [${scenario}] source=${source.id}: ${resolved.providerId ?? 'unknown'} - ${resolved.modelId}`,
      );
      return resolved;
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
    this.cache.delete(scenario);
  }

  private async decryptConfig(config: AIModelConfig): Promise<AIModelConfig> {
    if (!this.apiKeyDecryptor || !config.apiKey) return { ...config };
    return {
      ...config,
      apiKey: await Promise.resolve(this.apiKeyDecryptor(config.apiKey)),
    };
  }

  private setCache(scenario: string, config: AIModelConfig): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.findOldestCacheKey();
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(scenario, { config, cachedAt: Date.now() });
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
