/** The e2e-only fake AI switch must never be usable in production and must not touch real providers. */
import { aiTestFakeChatFactory, aiTestFakeMediaProviders, aiTestFakesEnabled } from '../src/ai-connections/ai-test-fakes';

describe('AI_TEST_FAKE_PROVIDERS', () => {
  it('is off unless explicitly true', () => {
    expect(aiTestFakesEnabled({})).toBe(false);
    expect(aiTestFakesEnabled({ AI_TEST_FAKE_PROVIDERS: 'false' })).toBe(false);
    expect(() => aiTestFakesEnabled({ AI_TEST_FAKE_PROVIDERS: '1' })).toThrow(/true or false/);
  });

  it('refuses to start in production', () => {
    expect(() => aiTestFakesEnabled({ AI_TEST_FAKE_PROVIDERS: 'true', NODE_ENV: 'production' })).toThrow(/refused/);
    expect(aiTestFakesEnabled({ AI_TEST_FAKE_PROVIDERS: 'true', NODE_ENV: 'test' })).toBe(true);
  });

  it('provides a fake chat factory and one fake media provider for all kinds', async () => {
    const factory = await aiTestFakeChatFactory({ AI_TEST_FAKE_CHUNK_DELAY_MS: '0' });
    const model = await factory({ provider: 'openai-compatible', modelId: 'm', apiKey: 'k' } as never);
    const reply = await model.chat({ messages: [{ role: 'user', content: 'hi' }] } as never, new AbortController().signal);
    expect(reply.content).toBe('Echo: hi');
    const [entry] = await aiTestFakeMediaProviders({});
    expect(entry).toMatchObject({ providerId: 'fake-media', kinds: ['image', 'video', 'audio'] });
    expect(() => aiTestFakeMediaProviders({ AI_TEST_FAKE_MEDIA_DELAY_MS: '-1' })).rejects.toThrow();
  });
});
