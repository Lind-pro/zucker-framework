import type {
  AIConfigSource,
  AIModuleOptions,
  AIScenario,
  AIModelConfig,
} from '@zucker-framework/ai';
import {
  AI_CONNECTIONS,
  AIConnectionUnavailableError,
  aiConnectionConfig,
  aiConnectionEnabled,
  validateAIConnection,
  type AIConnectionEnvironment,
} from './ai-connections.config';

export const RUNTIME_AI_CONNECTION_SOURCE_ID = 'runtime-connections';
export interface AIConnectionRoutingOptions {
  /** Consumer-owned scenario names mapped to the fixed connection routes. No implicit default. */
  routes?: Readonly<Record<string, string>>;
}
/** Terminal source: unknown and disabled routes must never fall through to legacy database defaults. */
export class RuntimeAIConnectionSource implements AIConfigSource {
  readonly id = RUNTIME_AI_CONNECTION_SOURCE_ID;
  readonly priority = Number.MAX_SAFE_INTEGER;
  readonly failureMode = 'throw' as const;
  private readonly environment: AIConnectionEnvironment;
  private readonly routes: Readonly<Record<string, string>>;
  constructor(environment: AIConnectionEnvironment, options: AIConnectionRoutingOptions = {}) {
    this.environment = Object.freeze({ ...environment });
    for (const [alias, route] of Object.entries(options.routes ?? {})) {
      if (
        !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(alias) ||
        alias.startsWith('connection.') ||
        !AI_CONNECTIONS.some((definition) => definition.route === route)
      )
        throw new AIConnectionUnavailableError('unknown_route');
    }
    this.routes = Object.freeze({ ...options.routes });
  }
  async getScenarioConfig(route: string): Promise<AIModelConfig> {
    const target = Object.hasOwn(this.routes, route) ? this.routes[route] : route;
    const definition = AI_CONNECTIONS.find((item) => item.route === target);
    if (!definition) throw new AIConnectionUnavailableError('unknown_route');
    return aiConnectionConfig(definition, this.environment);
  }
  async getScenarios(): Promise<AIScenario[]> {
    const scenarios: AIScenario[] = [];
    for (const definition of AI_CONNECTIONS) {
      if (!aiConnectionEnabled(definition, this.environment)) continue;
      const config = aiConnectionConfig(definition, this.environment);
      scenarios.push({
        id: definition.route,
        name: definition.name,
        provider: definition.provider,
        model: config.modelId,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 4096,
      });
      for (const [alias, route] of Object.entries(this.routes))
        if (route === definition.route)
          scenarios.push({
            id: alias,
            name: alias,
            provider: definition.provider,
            model: config.modelId,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 4096,
          });
    }
    return scenarios;
  }
}

/** Called once by the composition root with the decrypted, immutable startup snapshot. */
export async function aiModuleOptionsFromEnvironment(
  environment: AIConnectionEnvironment,
  options: AIConnectionRoutingOptions = {},
): Promise<AIModuleOptions> {
  const source = new RuntimeAIConnectionSource(environment, options);
  for (const definition of AI_CONNECTIONS) await validateAIConnection(definition.id, environment);
  return { configSources: [source] };
}
