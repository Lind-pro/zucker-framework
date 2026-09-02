import { describe, expect, it } from 'vitest';
import { InMemoryCredentialProfileStore } from '@zucker/ai-access';
import {
  CodexSubscriptionAuthClient,
  CodexSubscriptionCredentialManager,
} from './codex-subscription-auth';
import { OpenAICodexSubscriptionProvider } from './providers/openai-codex.provider';

describe('@zucker/ai AI Access compatibility exports', () => {
  it('继续导出 Codex 认证和 Provider', () => {
    const store = new InMemoryCredentialProfileStore();

    expect(new CodexSubscriptionAuthClient({ store })).toBeInstanceOf(
      CodexSubscriptionAuthClient,
    );
    expect(new CodexSubscriptionCredentialManager({ store })).toBeInstanceOf(
      CodexSubscriptionCredentialManager,
    );
    expect(new OpenAICodexSubscriptionProvider({ store })).toBeInstanceOf(
      OpenAICodexSubscriptionProvider,
    );
  });
});
