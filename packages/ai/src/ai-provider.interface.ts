export interface AIProvider {
  id: string;
  name: string;
  createModel(config: AIModelConfig): unknown | Promise<unknown>;
}

export interface AIModelConfig {
  apiKey: string;
  baseURL?: string;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  /** Top-p (nucleus) sampling parameter */
  topP?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  proxyUrl?: string;
  /**
   * Provider id（如 'openai' / 'deepseek' / 'anthropic' / 'gemini'）。
   * 由 AIConfigService.getScenarioConfig 从数据库 record 中提取。
   * 消费方用此 id 在 AIProviderManager 中查找具体 provider 实例。
   *
   * 注：此字段大小写敏感，遵循 provider.id（小写）。从数据库读出的
   * record.provider（如 'OpenAI'）会自动转小写。
   */
  providerId?: string;
}

export interface AIScenario {
  id: string;
  name: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Token 使用量，跨框架统一字段命名（input/output/total）。
 * 与 AIInvocationResult.tokenUsage 同形。
 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface AIInvocationResult {
  content: string;
  tokenUsage: TokenUsage;
  duration: number;
  cost: number;
  /** The provider ID that handled the request */
  provider?: string;
  /** The model ID used */
  model?: string;
  /** Finish reason from the API (e.g. 'stop', 'length', 'content_filter') */
  finishReason?: string;
}

/** Classification of AI invocation errors */
export enum AIErrorType {
  /** Authentication/authorization failure */
  AUTH = 'AUTH',
  /** Rate limit exceeded */
  RATE_LIMIT = 'RATE_LIMIT',
  /** Request timeout */
  TIMEOUT = 'TIMEOUT',
  /** Invalid request parameters */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** Model/server error */
  SERVER_ERROR = 'SERVER_ERROR',
  /** Unknown error */
  UNKNOWN = 'UNKNOWN',
  /** Network or connection failure */
  NETWORK = 'NETWORK',
  /** Provider content or safety policy rejection */
  CONTENT_POLICY = 'CONTENT_POLICY',
  /** Explicit caller cancellation */
  CANCELLED = 'CANCELLED',
}
