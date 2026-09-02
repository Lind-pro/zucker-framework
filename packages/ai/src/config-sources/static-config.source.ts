import type { AIModelConfig, AIScenario } from '../ai-provider.interface';
import type { AIConfigSource, AIConfigSourceOptions } from '../config-source';

export interface StaticAIConfigSourceOptions extends AIConfigSourceOptions {
  scenarios?: Record<string, AIModelConfig>;
  defaultConfig?: AIModelConfig;
}
export class StaticAIConfigSource implements AIConfigSource {
  readonly id: string;
  readonly priority: number;
  readonly failureMode;
  private readonly scenarios: Record<string, AIModelConfig>;
  private readonly defaultConfig?: AIModelConfig;

  constructor(options: StaticAIConfigSourceOptions) {
    this.id = options.id ?? 'static';
    this.priority = options.priority ?? 100;
    this.failureMode = options.failureMode ?? 'continue';
    this.scenarios = options.scenarios ?? {};
    this.defaultConfig = options.defaultConfig;
  }

  async getScenarioConfig(scenario: string): Promise<AIModelConfig | null> {
    return this.scenarios[scenario] ?? this.defaultConfig ?? null;
  }

  async getScenarios(): Promise<AIScenario[]> {
    return Object.entries(this.scenarios).map(([id, config]) => ({
      id,
      name: id,
      provider: config.providerId ?? 'openai',
      model: config.modelId,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096,
    }));
  }
}
