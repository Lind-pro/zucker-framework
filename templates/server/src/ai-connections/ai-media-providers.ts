import {
  DalleProvider,
  HttpAsyncTaskMediaProvider,
  MediaType,
  type AIProviderCallbackVerifier,
  type HttpAsyncTaskAdapterConfig,
  type HttpAsyncTaskCallbackVerifierOptions,
  type MediaProvider,
} from '@zucker-framework/ai';
import { AI_CONNECTIONS, aiConnectionConfig, aiConnectionEnabled, type AIConnectionEnvironment } from './ai-connections.config';

/** Media kinds of `@zucker-framework/ai-tasks`. */
export type AIMediaKind = 'image' | 'video' | 'audio';

/**
 * One server-side media provider the AI task worker may call. `providerId` is the id used by the
 * `ai-catalog` policy and stored on each task; `config` holds credentials and is never persisted,
 * logged or returned.
 */
export interface AIMediaProviderEntry {
  providerId: string;
  name: string;
  kinds: readonly AIMediaKind[];
  provider: Pick<MediaProvider, 'id' | 'supportedTypes' | 'generate' | 'getTaskStatus' | 'getCapabilities'>;
  config: { apiKey: string } & Record<string, unknown>;
  /** Present when the provider signs callbacks (`POST /api/ai/tasks/callbacks/:providerId`). */
  verifier?: Pick<AIProviderCallbackVerifier, 'verify' | 'hint'>;
}

/** Explicit test/transport seam: the media providers resolved at startup. */
export const AI_MEDIA_PROVIDERS = Symbol('AI_MEDIA_PROVIDERS');

/** Same id rule as the admin catalog editor (WP 2.5). */
export const AI_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KIND_OF: Readonly<Record<string, AIMediaKind>> = { [MediaType.IMAGE]: 'image', [MediaType.VIDEO]: 'video', [MediaType.AUDIO]: 'audio' };

export class AIMediaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIMediaConfigurationError';
  }
}

function envName(id: string): string {
  return id.replaceAll('-', '_').toUpperCase();
}

type AdapterDeclaration = HttpAsyncTaskAdapterConfig & {
  /** Callback verification (HMAC); the secret comes from `AI_MEDIA_<ID>_CALLBACK_SECRET`. */
  callback?: Omit<HttpAsyncTaskCallbackVerifierOptions, 'secret' | 'now'>;
};

/**
 * Media providers from the startup environment snapshot:
 * - `ai-openai` (image): the OpenAI connection's key/base URL through the DALL·E images API, when
 *   `AI_OPENAI_ENABLED=true`.
 * - Generic async adapters (`HttpAsyncTaskMediaProvider`, vendor neutral) declared as a JSON array in
 *   `AI_MEDIA_ADAPTERS`; each needs `AI_MEDIA_<ID>_API_KEY` (unless `auth.type` is `none`) and may
 *   declare `callback` with `AI_MEDIA_<ID>_CALLBACK_SECRET`. Invalid declarations fail startup
 *   instead of silently dropping a provider.
 */
export function aiMediaProvidersFromEnvironment(env: AIConnectionEnvironment): AIMediaProviderEntry[] {
  const entries: AIMediaProviderEntry[] = [];
  const openai = AI_CONNECTIONS.find(definition => definition.id === 'ai-openai')!;
  if (aiConnectionEnabled(openai, env)) {
    const config = aiConnectionConfig(openai, env);
    entries.push({ providerId: 'ai-openai', name: 'OpenAI Images', kinds: ['image'], provider: new DalleProvider(),
      config: { apiKey: config.apiKey, baseURL: config.baseURL, timeoutMs: config.timeoutMs } });
  }
  const raw = env.AI_MEDIA_ADAPTERS?.trim();
  if (raw) {
    let declarations: unknown;
    try { declarations = JSON.parse(raw); } catch { throw new AIMediaConfigurationError('AI_MEDIA_ADAPTERS must be a JSON array'); }
    if (!Array.isArray(declarations) || declarations.length > 20) throw new AIMediaConfigurationError('AI_MEDIA_ADAPTERS must be a JSON array of at most 20 adapters');
    for (const declaration of declarations as AdapterDeclaration[]) {
      if (!declaration || typeof declaration !== 'object' || typeof declaration.id !== 'string' || !AI_PROVIDER_ID.test(declaration.id))
        throw new AIMediaConfigurationError('Each AI media adapter needs an id matching ^[a-z0-9][a-z0-9_-]{0,63}$');
      const { callback, ...adapter } = declaration;
      const provider = new HttpAsyncTaskMediaProvider(adapter);
      const prefix = `AI_MEDIA_${envName(adapter.id)}`;
      const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
      if (adapter.auth?.type !== 'none' && !apiKey) throw new AIMediaConfigurationError(`${prefix}_API_KEY is required`);
      let verifier: AIMediaProviderEntry['verifier'];
      if (callback) {
        const secret = env[`${prefix}_CALLBACK_SECRET`] ?? '';
        verifier = provider.createCallbackVerifier({ ...callback, secret });
      }
      entries.push({ providerId: adapter.id, name: adapter.name ?? adapter.id, kinds: provider.supportedTypes.map(type => KIND_OF[type]).filter(Boolean),
        provider, config: { apiKey }, ...(verifier ? { verifier } : {}) });
    }
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.providerId)) throw new AIMediaConfigurationError(`AI media provider ${entry.providerId} is declared twice`);
    ids.add(entry.providerId);
  }
  return entries;
}
