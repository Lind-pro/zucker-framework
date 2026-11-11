import { Module } from '@nestjs/common';
import type { AIConfigService } from '@zucker-framework/ai';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider } from '../runtime-settings/hot-apply';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { AI_CONNECTIONS, type AIConnectionEnvironment } from './ai-connections.config';
import { aiMediaProvidersFromEnvironment, type AIMediaProviderEntry } from './ai-media-providers';
import { aiTestFakeMediaProviders, aiTestFakesEnabled } from './ai-test-fakes';

/** One revision of the AI connection profiles: the environment AI features read and the media providers built from it. */
export interface AIConnectionSnapshot {
  readonly environment: AIConnectionEnvironment;
  readonly media: readonly AIMediaProviderEntry[];
}
/** Hot provider of every native AI connection profile (`ai-*`, `applyMode: 'hot'`). */
export const AI_CONNECTION_RUNTIME = Symbol('AI_CONNECTION_RUNTIME');
export type AIConnectionRuntime = HotProvider<AIConnectionSnapshot>;
export const AI_CONNECTION_PROFILE_IDS: readonly string[] = AI_CONNECTIONS.map(connection => connection.id);

/**
 * Builds the AI runtime. A save of an `ai-*` profile rebuilds the snapshot on the next read: the
 * chat/model configuration (`RuntimeAIConnectionSource`), `AI_CONNECTION_ENVIRONMENT` and
 * `AI_MEDIA_PROVIDERS`. A call that already resolved its configuration (a streaming chat, a media
 * task submission) keeps it. The test-only fake media providers keep in-memory task state, so they are
 * created once and reused across revisions (they do not depend on any profile field).
 */
export function createAIConnectionRuntime(settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>): Promise<AIConnectionRuntime> {
  let fakes: Promise<AIMediaProviderEntry[]> | undefined;
  return HotProvider.create<AIConnectionSnapshot>(settings, environment, {
    name: 'AI connections', profiles: AI_CONNECTION_PROFILE_IDS,
    build: async env => {
      const frozen = Object.freeze({ ...env });
      const media = aiTestFakesEnabled(frozen) ? await (fakes ??= aiTestFakeMediaProviders(frozen)) : aiMediaProvidersFromEnvironment(frozen);
      return Object.freeze({ environment: frozen, media: Object.freeze([...media]) });
    },
  }).ready();
}

/**
 * Ties `AIConfigService`'s per-scenario cache (keyed by scenario only, 60 s) to the AI runtime revision:
 * a lookup that resolves to another snapshot than the previous one (a saved `ai-*` profile, or a request
 * pinned to another revision) clears the cache first, so a cached config never outlives its revision,
 * while an unchanged revision keeps the normal cache. A lookup that raced a revision change clears what
 * it may have cached, so a superseded config can never stay behind for the newer revision.
 */
export function bindAIConfigCacheToRuntime(configs: AIConfigService, runtime: AIConnectionRuntime): void {
  const lookup = configs.getScenarioConfig.bind(configs);
  let seen: AIConnectionSnapshot | undefined;
  configs.getScenarioConfig = async (scenario, options) => {
    const snapshot = await runtime.current();
    if (snapshot !== seen) { configs.clearCache(); seen = snapshot; }
    try {
      return await lookup(scenario, options);
    } finally {
      if (seen !== snapshot) configs.clearCache();
    }
  };
}

/**
 * Provides `AI_CONNECTION_RUNTIME` once for the application; imported by the `ZuckerAIModule` options
 * factory (composition root) and by `AIConnectionsModule`, so both read the same instance.
 */
@Module({
  providers: [{ provide: AI_CONNECTION_RUNTIME, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => createAIConnectionRuntime(settings, environment) }],
  exports: [AI_CONNECTION_RUNTIME],
})
export class AIConnectionRuntimeModule {}
