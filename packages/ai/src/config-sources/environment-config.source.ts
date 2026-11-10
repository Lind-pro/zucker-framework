import type { AIModelConfig } from '../ai-provider.interface';
import type { AIConfigSource, AIConfigSourceOptions, ScenarioConfigOptions } from '../config-source';

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export interface EnvironmentAIConfigSourceOptions extends AIConfigSourceOptions {
  env: EnvironmentValues;
  prefix?: string;
}
const scenarioKey = (scenario: string): string =>
  scenario
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

const parseNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class EnvironmentAIConfigSource implements AIConfigSource {
  readonly id: string;
  readonly priority: number;
  readonly failureMode;
  private readonly env: EnvironmentValues;
  private readonly prefix: string;

  constructor(options: EnvironmentAIConfigSourceOptions) {
    this.id = options.id ?? 'environment';
    this.priority = options.priority ?? 300;
    this.failureMode = options.failureMode ?? 'continue';
    this.env = options.env;
    this.prefix = (options.prefix ?? 'AI').replace(/_+$/g, '');
  }

  async getScenarioConfig(scenario: string, options: ScenarioConfigOptions = {}): Promise<AIModelConfig | null> {
    const scopedPrefix = `${this.prefix}_${scenarioKey(scenario)}_`;
    // Shared credentials may be inherited, but strict lookup requires a scoped model.
    if (options.allowDefault === false &&
        !this.env[`${scopedPrefix}MODEL_ID`] && !this.env[`${scopedPrefix}MODEL`]) return null;
    const read = (name: string): string | undefined =>
      this.env[`${scopedPrefix}${name}`] ?? this.env[`${this.prefix}_${name}`];
    const modelId = this.env[`${scopedPrefix}MODEL_ID`] ?? this.env[`${scopedPrefix}MODEL`] ??
      this.env[`${this.prefix}_MODEL_ID`] ?? this.env[`${this.prefix}_MODEL`];
    if (!modelId) return null;
    // A scoped model that targets a different provider or endpoint must carry its own key;
    // inheriting the global key would send one provider's credential to another host.
    const unscoped = (name: string) => this.env[`${this.prefix}_${name}`];
    const scoped = (name: string) => this.env[`${scopedPrefix}${name}`];
    const providerDiffers = scoped('PROVIDER') !== undefined && scoped('PROVIDER') !== unscoped('PROVIDER');
    const targetDiffers =
      providerDiffers ||
      (scoped('BASE_URL') !== undefined && scoped('BASE_URL') !== unscoped('BASE_URL'));
    const apiKey = targetDiffers ? scoped('API_KEY') : read('API_KEY');
    // Fail at configuration time instead of a provider 401 later. Only when a global key exists
    // (the operator evidently expected it to be inherited); keyless local providers still work.
    if (targetDiffers && apiKey === undefined && unscoped('API_KEY')) {
      throw new Error(
        `AI scenario '${scenario}' targets a different provider/endpoint than the global config and needs ` +
          `its own ${scopedPrefix}API_KEY (the global key is not inherited)`,
      );
    }
    return {
      apiKey: apiKey ?? '',
      // A scoped provider does not inherit the global endpoint: the scoped key belongs to that
      // provider, and the global BASE_URL belongs to another one.
      baseURL: providerDiffers ? scoped('BASE_URL') : read('BASE_URL'),
      modelId,
      providerId: read('PROVIDER')?.toLowerCase(),
      temperature: parseNumber(read('TEMPERATURE')),
      maxTokens: parseNumber(read('MAX_TOKENS')),
      topP: parseNumber(read('TOP_P')),
      timeoutMs: parseNumber(read('TIMEOUT_MS')),
      proxyUrl: read('PROXY_URL'),
    };
  }
}
