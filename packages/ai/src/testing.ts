/**
 * Test doubles for consumers of `@zucker-framework/ai` (deterministic, no network).
 * Not for production wiring.
 */
export { FakeMediaProvider, FAKE_PNG_BASE64 } from './testing/fake-media-provider';
export type { FakeMediaCall, FakeMediaProviderOptions, FakeMediaStep } from './testing/fake-media-provider';
export { FakeChatModel, fakeTokenCount } from './testing/fake-chat-model';
export type { FakeChatCall, FakeChatModelOptions, FakeChatStep } from './testing/fake-chat-model';
export { FakeCallbackVerifier } from './testing/fake-callback-verifier';
export type { FakeCallbackVerifierOptions } from './testing/fake-callback-verifier';
