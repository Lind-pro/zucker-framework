import type { AIModelConfig, AIScenario } from '../ai-provider.interface';
import type { AIConfigSource, AIConfigSourceOptions } from '../config-source';

export interface RemoteAIConfigSourceOptions extends AIConfigSourceOptions {
  baseUrl: string;
  headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  timeoutMs?: number;
  fetcher?: typeof fetch;
  transform?: (
    payload: unknown,
    scenario: string,
  ) => AIModelConfig | null | Promise<AIModelConfig | null>;
  scenariosPath?: string;
}

interface RemoteConfigShape {
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
  modelId?: string;
  model?: string;
  providerId?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  proxyUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrapPayload = (payload: unknown): unknown => {
  if (!isRecord(payload)) return payload;
  return payload.result ?? payload.data ?? payload;
};

export class RemoteAIConfigSource implements AIConfigSource {
  readonly id: string;
  readonly priority: number;
  readonly failureMode;
  private readonly baseUrl: string;
  private readonly headers;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly transform;
  private readonly scenariosPath?: string;

  constructor(options: RemoteAIConfigSourceOptions) {
    this.id = options.id ?? 'remote';
    this.priority = options.priority ?? 200;
    this.failureMode = options.failureMode ?? 'continue';
    this.baseUrl = options.baseUrl.replace(/\/+$/g, '');
    this.headers = options.headers;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetcher ?? fetch;
    this.transform = options.transform;
    this.scenariosPath = options.scenariosPath;
  }

  async getScenarioConfig(scenario: string): Promise<AIModelConfig | null> {
    const payload = await this.request(`${this.baseUrl}/${encodeURIComponent(scenario)}`);
    if (payload === null) return null;
    if (this.transform) return this.transform(payload, scenario);
    const config = unwrapPayload(payload) as RemoteConfigShape;
    const modelId = config.modelId ?? config.model;
    if (!modelId) return null;
    return {
      apiKey: config.apiKey ?? '',
      baseURL: config.baseURL ?? config.baseUrl,
      modelId,
      providerId: (config.providerId ?? config.provider)?.toLowerCase(),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      timeoutMs: config.timeoutMs,
      proxyUrl: config.proxyUrl,
    };
  }

  async getScenarios(): Promise<AIScenario[]> {
    if (!this.scenariosPath) return [];
    const payload = await this.request(`${this.baseUrl}/${this.scenariosPath.replace(/^\/+/, '')}`);
    const data = unwrapPayload(payload);
    return Array.isArray(data) ? (data as AIScenario[]) : [];
  }

  private async request(url: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = typeof this.headers === 'function' ? this.headers() : this.headers;
      const response = await this.fetcher(url, { headers, signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`远程 AI 配置请求失败: HTTP ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
