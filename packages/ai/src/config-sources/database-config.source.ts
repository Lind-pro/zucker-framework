import { BusinessException, type DatabaseAdapter } from '@zucker-framework/core';
import type { AIModelConfig, AIScenario } from '../ai-provider.interface';
import type { AIConfigSource, AIConfigSourceOptions } from '../config-source';

interface AIModelRecord {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  proxyHost?: string;
  proxyPort?: number;
  isEnabled: boolean;
  isDefault?: boolean;
  scenarios?: string[];
}
export interface DatabaseAIConfigSourceOptions extends AIConfigSourceOptions {
  modelName?: string;
}

export class DatabaseAIConfigSource implements AIConfigSource {
  readonly id: string;
  readonly priority: number;
  readonly failureMode;
  private readonly modelName: string;

  constructor(
    private readonly db: DatabaseAdapter,
    options: DatabaseAIConfigSourceOptions = {},
  ) {
    this.id = options.id ?? 'database';
    this.priority = options.priority ?? 100;
    this.failureMode = options.failureMode ?? 'throw';
    this.modelName = options.modelName ?? 'aiModels';
  }

  async getScenarioConfig(scenario: string): Promise<AIModelConfig | null> {
    try {
      const operations = this.db.model(this.modelName);
      let model = operations.findFirst
        ? await operations.findFirst({ where: { isEnabled: true, scenarios: { has: scenario } } })
        : null;
      if (!model && operations.findFirst) {
        model = await operations.findFirst({ where: { isEnabled: true, isDefault: true } });
      }
      return model ? this.toConfig(model as AIModelRecord) : null;
    } catch (error) {
      throw new BusinessException(
        `AI 模型查询失败 (scenario=${scenario}): ${error instanceof Error ? error.message : String(error)}`,
        'AI_MODEL_QUERY_FAILED',
        500,
      );
    }
  }

  async getScenarios(): Promise<AIScenario[]> {
    try {
      const models = await this.db.model(this.modelName).findMany({ where: { isEnabled: true } });
      return (models as AIModelRecord[]).map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        model: model.modelId,
        temperature: model.temperature ?? 0.7,
        maxTokens: model.maxTokens ?? 4096,
      }));
    } catch (error) {
      throw new BusinessException(
        `获取 AI 场景列表失败: ${error instanceof Error ? error.message : String(error)}`,
        'AI_SCENARIO_QUERY_FAILED',
        500,
      );
    }
  }

  private toConfig(model: AIModelRecord): AIModelConfig {
    return {
      apiKey: model.apiKey,
      baseURL: model.baseUrl || undefined,
      modelId: model.modelId,
      temperature: model.temperature ?? 0.7,
      maxTokens: model.maxTokens ?? 4096,
      topP: model.topP,
      timeoutMs: model.timeoutMs,
      proxyUrl:
        model.proxyHost && model.proxyPort
          ? `http://${model.proxyHost}:${model.proxyPort}`
          : undefined,
      providerId: model.provider ? model.provider.toLowerCase() : undefined,
    };
  }
}
