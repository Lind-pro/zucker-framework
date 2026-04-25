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
}

export interface AIScenario {
  id: string;
  name: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AIInvocationResult {
  content: string;
  tokenUsage: { input: number; output: number; total: number };
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
}
