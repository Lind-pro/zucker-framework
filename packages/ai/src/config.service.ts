import { Injectable, Inject, Logger } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException, NotFoundException, BusinessException } from '@zucker/core';
import { AIScenario, AIModelConfig } from './ai-provider.interface';

import { DATABASE_ADAPTER } from '@zucker/crud';

/** Maximum number of cached scenario configs to prevent memory leaks */
const MAX_CACHE_SIZE = 200;

/** Database record shape for AI model configuration */
interface AIModelRecord {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  proxyHost?: string;
  proxyPort?: number;
  isEnabled: boolean;
  isDefault?: boolean;
  scenarios?: string[];
}

@Injectable()
export class AIConfigService {
  private readonly logger = new Logger(AIConfigService.name);
  private readonly cache = new Map<string, { config: AIModelConfig; cachedAt: number }>();
  private cacheTtl = 60_000;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /** Update the cache TTL (in milliseconds). Existing cached entries use the new TTL on next access. */
  setCacheTtl(ttlMs: number): void {
    if (ttlMs > 0 && Number.isFinite(ttlMs)) {
      this.cacheTtl = ttlMs;
    }
  }

  async getScenarioConfig(scenario: string): Promise<AIModelConfig> {
    if (!scenario || typeof scenario !== 'string') {
      throw new ValidationException(
        { scenario: ['场景名称不能为空'] },
        '场景名称不能为空',
      );
    }

    const cached = this.cache.get(scenario);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.config;
    }

    const model = await this.findModel(scenario);
    const config: AIModelConfig = {
      apiKey: model.apiKey,
      baseURL: model.baseUrl || undefined,
      modelId: model.modelId,
      temperature: model.temperature ?? 0.7,
      maxTokens: model.maxTokens ?? 4096,
      proxyUrl: model.proxyHost && model.proxyPort
        ? `http://${model.proxyHost}:${model.proxyPort}`
        : undefined,
    };

    // Evict oldest entries if cache exceeds max size
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.findOldestCacheKey();
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(scenario, { config, cachedAt: Date.now() });
    this.logger.log(`AI 配置已加载 [${scenario}]: ${model.provider} - ${model.modelId}`);
    return config;
  }

  async getScenarios(): Promise<AIScenario[]> {
    try {
      const models = await this.db.model('aiModels').findMany({
        where: { isEnabled: true },
      });

      return (models as AIModelRecord[]).map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        model: m.modelId,
        temperature: m.temperature ?? 0.7,
        maxTokens: m.maxTokens ?? 4096,
      }));
    } catch (error) {
      this.logger.error(`获取 AI 场景列表失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Remove a specific scenario from cache (useful after config update) */
  invalidateScenario(scenario: string): void {
    this.cache.delete(scenario);
  }

  private async findModel(scenario: string): Promise<AIModelRecord> {
    try {
      // Use findFirst instead of findUnique — scenarios query is not unique
      const ops = this.db.model('aiModels');
      let model = ops.findFirst
        ? await ops.findFirst({ where: { isEnabled: true, scenarios: { has: scenario } } })
        : null;
      if (model) return model as AIModelRecord;

      // Fallback to default model
      this.logger.warn(`场景 '${scenario}' 无匹配，使用默认模型`);
      model = ops.findFirst
        ? await ops.findFirst({ where: { isEnabled: true, isDefault: true } })
        : null;
      if (model) return model as AIModelRecord;
    } catch (error) {
      throw new BusinessException(
        `AI 模型查询失败 (scenario=${scenario}): ${error instanceof Error ? error.message : String(error)}`,
        'AI_MODEL_QUERY_FAILED',
        500,
      );
    }

    throw new NotFoundException(`AI 模型未配置 (scenario=${scenario})`);
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
