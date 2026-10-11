// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { CredentialProfile } from '../contracts';
import { InMemoryCredentialProfileStore } from '../in-memory-profile-store';
import {
  CodexSubscriptionAuthClient,
  CodexSubscriptionCredentialManager,
  OpenAICodexSubscriptionProvider,
  createOpenAICodexAccessProvider,
} from './openai-codex';

const now = 1_800_000_000_000;

const jwt = (expiresAt: number, accountId = 'acct-1'): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    exp: Math.floor(expiresAt / 1_000),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
};

const profile = (expiresAt = now + 60 * 60_000): CredentialProfile => ({
  id: 'openai-codex:default',
  providerId: 'openai-codex',
  profileName: 'default',
  authMethod: 'device-code',
  ownership: 'managed',
  credential: {
    kind: 'oauth',
    accessToken: jwt(expiresAt),
    refreshToken: 'refresh-1',
    expiresAt,
  },
  expiresAt,
  metadata: { accountId: 'acct-1', createdAt: now, updatedAt: now },
});

describe('OpenAI Codex access provider', () => {
  it('未过期的 Profile 不触发刷新', async () => {
    const store = new InMemoryCredentialProfileStore();
    await store.save(profile());
    const fetcher = vi.fn();
    const manager = new CodexSubscriptionCredentialManager({ store, fetcher, now: () => now });

    await expect(manager.getCredentials()).resolves.toMatchObject({ accountId: 'acct-1' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('并发刷新只消费一次 refresh token', async () => {
    const store = new InMemoryCredentialProfileStore();
    await store.save(profile(now - 1));
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: jwt(now + 60 * 60_000),
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const manager = new CodexSubscriptionCredentialManager({ store, fetcher, now: () => now });

    const [first, second] = await Promise.all([manager.getCredentials(), manager.getCredentials()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.refreshToken).toBe('refresh-2');
    expect(second.refreshToken).toBe('refresh-2');
  });

  it('设备码登录直接保存通用 Profile', async () => {
    const store = new InMemoryCredentialProfileStore();
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return new Response(
          JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        return new Response(
          JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: jwt(now + 60 * 60_000),
          refresh_token: 'refresh-device',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    const auth = new CodexSubscriptionAuthClient({
      store,
      fetcher,
      now: () => now,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await auth.loginWithDeviceCode({ onVerification: vi.fn() });

    await expect(store.get('openai-codex')).resolves.toMatchObject({
      providerId: 'openai-codex',
      ownership: 'managed',
      credential: { kind: 'oauth', refreshToken: 'refresh-device' },
    });
  });

  it('通过真实 OpenAI SDK 发送结构化 Responses 请求', async () => {
    const store = new InMemoryCredentialProfileStore();
    await store.save(profile());
    const events = [
      { type: 'response.output_text.delta', delta: 'public' },
      { type: 'response.output_text.delta', delta: ' ' },
      { type: 'response.output_text.delta', delta: 'final' },
      { type: 'response.output_text.delta', delta: '\n' },
      { type: 'response.output_text.delta', delta: 'class' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          status: 'completed',
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      },
    ];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    const provider = new OpenAICodexSubscriptionProvider({ store, fetcher });
    const client = await provider.createModel({ modelId: 'gpt-5.6-luna' });

    const deltas: string[] = [];
    await expect(
      client.complete({
        input: '验证',
        textVerbosity: 'high',
        onTextDelta: async (delta) => {
          deltas.push(delta);
        },
      }),
    ).resolves.toMatchObject({
      content: 'public final\nclass',
      tokenUsage: { total: 6 },
    });
    expect(deltas).toEqual(['public', ' ', 'final', '\n', 'class']);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('acct-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      text: { verbosity: 'high' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: '验证' }] }],
    });
  });

  it('Provider 插件可被通用 Registry 使用且不泄漏供应商分支', () => {
    const plugin = createOpenAICodexAccessProvider();
    expect(plugin.id).toBe('openai-codex');
    expect(plugin.authMethods.map((method) => method.id)).toEqual(['device-code']);
    expect(plugin.runtime.complete).toBeTypeOf('function');
  });

  it.each([
    ['truncated stream', []],
    ['incomplete response', [{ type: 'response.incomplete', response: { status: 'incomplete' } }]],
    ['missing usage', [{ type: 'response.completed', response: { status: 'completed' } }]],
  ])('rejects %s instead of reporting a successful answer', async (_label, terminal) => {
    const store = new InMemoryCredentialProfileStore();
    await store.save(profile());
    const events = [{ type: 'response.output_text.delta', delta: 'partial answer' }, ...terminal];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    const provider = new OpenAICodexSubscriptionProvider({ store, fetcher });
    const client = await provider.createModel({ modelId: 'synthetic' });
    const deltas: string[] = [];
    await expect(
      client.complete({
        input: 'synthetic',
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(deltas).toEqual(['partial answer']);
  });

  it.each(['failure', 'cancellation'] as const)(
    'stops the actual SDK stream on delta consumer %s',
    async (outcome) => {
      const store = new InMemoryCredentialProfileStore();
      await store.save(profile());
      const events = [
        { type: 'response.output_text.delta', delta: 'first' },
        { type: 'response.output_text.delta', delta: ' second' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      ];
      const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      const provider = new OpenAICodexSubscriptionProvider({ store, fetcher });
      const client = await provider.createModel({ modelId: 'synthetic' });
      const controller = new AbortController();
      const failure = new Error('synthetic stop');
      const deltas: string[] = [];
      await expect(
        client.complete({
          input: 'synthetic',
          signal: controller.signal,
          onTextDelta: (delta) => {
            deltas.push(delta);
            if (outcome === 'failure') throw failure;
            controller.abort(failure);
          },
        }),
      ).rejects.toBe(failure);
      expect(deltas).toEqual(['first']);
      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
    },
  );
});
