import type { NativeModelFactory } from '@zucker-framework/ai';
import type { AIMediaProviderEntry } from './ai-media-providers';

/**
 * TEST-ONLY switch for end-to-end runs without paid providers: `AI_TEST_FAKE_PROVIDERS=true` replaces
 * the native chat model factory with `FakeChatModel` and the media providers with one
 * `FakeMediaProvider` (`providerId` `fake-media`, models `fake-image`/`fake-video`/`fake-audio`), both
 * from `@zucker-framework/ai/testing`. It refuses to start when `NODE_ENV=production`, and the testing
 * module is loaded only when the switch is on. Optional knobs (milliseconds): `AI_TEST_FAKE_CHUNK_DELAY_MS`
 * (default 150, per streamed chunk) and `AI_TEST_FAKE_MEDIA_DELAY_MS` (default 300, per poll).
 * Chat still needs an enabled connection (e.g. `AI_COMPATIBLE_ENABLED=true` with dummy key/model);
 * nothing is sent to its base URL.
 */
export const AI_TEST_FAKE_PROVIDERS_ENV = 'AI_TEST_FAKE_PROVIDERS';

type Env = Readonly<Record<string, string | undefined>>;

export function aiTestFakesEnabled(env: Env): boolean {
  const value = env[AI_TEST_FAKE_PROVIDERS_ENV]?.trim();
  if (!value || value === 'false') return false;
  if (value !== 'true') throw new Error(`${AI_TEST_FAKE_PROVIDERS_ENV} must be true or false`);
  if (env.NODE_ENV === 'production')
    throw new Error(`${AI_TEST_FAKE_PROVIDERS_ENV} is a test-only switch and is refused when NODE_ENV=production`);
  return true;
}

function delay(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) throw new Error(`${key} must be 0..60000`);
  return value;
}

export async function aiTestFakeChatFactory(env: Env): Promise<NativeModelFactory> {
  const { FakeChatModel } = await import('@zucker-framework/ai/testing');
  return new FakeChatModel({ defaultStep: { delayMs: delay(env, 'AI_TEST_FAKE_CHUNK_DELAY_MS', 150) } }).factory;
}

export async function aiTestFakeMediaProviders(env: Env): Promise<AIMediaProviderEntry[]> {
  const { FakeMediaProvider, FakeCallbackVerifier } = await import('@zucker-framework/ai/testing');
  const provider = new FakeMediaProvider({ defaultStep: { mode: 'async', pollsUntilDone: 2, delayMs: delay(env, 'AI_TEST_FAKE_MEDIA_DELAY_MS', 300) } });
  return [{ providerId: provider.id, name: 'Fake media (test only)', kinds: ['image', 'video', 'audio'], provider,
    config: { apiKey: 'fake-test-key' }, verifier: new FakeCallbackVerifier({ providerId: provider.id }) }];
}
