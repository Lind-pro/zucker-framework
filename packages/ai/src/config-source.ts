import type { AIModelConfig, AIScenario } from './ai-provider.interface';

export const AI_CONFIG_SOURCES = Symbol('AI_CONFIG_SOURCES');

export type AIConfigSourceFailureMode = 'continue' | 'throw';

export interface AIConfigSource {
  readonly id: string;
  readonly priority?: number;
  readonly failureMode?: AIConfigSourceFailureMode;
  getScenarioConfig(scenario: string): Promise<AIModelConfig | null>;
  getScenarios?(): Promise<AIScenario[]>;
}

export interface AIConfigSourceOptions {
  id?: string;
  priority?: number;
  failureMode?: AIConfigSourceFailureMode;
}

