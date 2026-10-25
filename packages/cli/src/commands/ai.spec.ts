// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIAccessProviderRegistry,
  InMemoryCredentialProfileStore,
  credentialProfileId,
  type AIAccessProviderPlugin,
  type CredentialProfile,
  type CredentialProfileStore,
} from '@zucker-framework/ai-access';
import { createAICommand } from './ai';

const now = 1_800_000_000_000;

const createProfile = (profileName: string): CredentialProfile => ({
  id: credentialProfileId('fake-provider', profileName),
  providerId: 'fake-provider',
  profileName,
  authMethod: 'fake-auth',
  ownership: 'managed',
  credential: { kind: 'token', token: 'secret-value', expiresAt: now },
  expiresAt: now,
  metadata: { createdAt: now - 1_000, updatedAt: now - 1_000 },
});

describe('zucker ai', () => {
  let store: CredentialProfileStore;
  let registry: AIAccessProviderRegistry;
  let provider: AIAccessProviderPlugin;
  let output: string[];
  let schemaInitializations: number;

  beforeEach(() => {
    store = new InMemoryCredentialProfileStore();
    schemaInitializations = 0;
    store.ensureSchema = vi.fn(async () => {
      schemaInitializations += 1;
    });
    provider = {
      id: 'fake-provider',
      name: 'Fake Provider',
      authMethods: [
        {
          id: 'fake-auth',
          label: 'Fake Auth',
          kind: 'custom',
          login: async (context) => {
            const profile = createProfile(context.profileName);
            await context.store.save(profile);
            return profile;
          },
        },
      ],
      credentialSources: [
        {
          id: 'fake-file',
          label: 'Fake File',
          kind: 'file',
          ownership: 'managed',
          discover: async (context) => [createProfile(context.profileName)],
        },
      ],
      runtime: {
        complete: async (request) => ({
          content: `${request.model}:ok`,
          finishReason: 'completed',
          tokenUsage: { input: 2, output: 1, total: 3 },
        }),
      },
    };
    registry = new AIAccessProviderRegistry();
    registry.register(provider);
    output = [];
  });

  const command = () => createAICommand({
    registry,
    env: { DATABASE_URL: 'postgresql://test' },
    createStore: async () => ({ store, close: async () => undefined }),
    write: (message) => output.push(message),
  });

  it('列出注册表中的 Provider，不依赖平台分支', async () => {
    await command().parseAsync(['providers'], { from: 'user' });

    expect(output.join('\n')).toContain('fake-provider  Fake Provider');
    expect(output.join('\n')).toContain('fake-auth');
    expect(output.join('\n')).toContain('fake-file');
  });

  it('初始化 PostgreSQL Profile Store', async () => {
    await command().parseAsync(['store', 'init'], { from: 'user' });

    expect(schemaInitializations).toBe(1);
    expect(output).toContain('AI Profile 存储已初始化。');
  });

  it('通过 Provider 的认证插件登录并显示脱敏状态', async () => {
    await command().parseAsync(['login', 'fake-provider', '--profile', 'team'], { from: 'user' });
    await command().parseAsync(['status', 'fake-provider'], { from: 'user' });

    expect(await store.get('fake-provider', 'team')).not.toBeNull();
    expect(output.join('\n')).toContain('fake-provider/team');
    expect(output.join('\n')).not.toContain('secret-value');
  });

  it('通过通用 file 凭据源导入 Profile', async () => {
    await command().parseAsync([
      'profile',
      'import',
      'fake-provider',
      '--from-file',
      '/tmp/fake.json',
      '--profile',
      'imported',
    ], { from: 'user' });

    expect(await store.get('fake-provider', 'imported')).not.toBeNull();
    expect(output).toContain('已导入 1 个 fake-provider Profile。');
  });

  it('通过 Provider runtime 运行指定模型', async () => {
    await command().parseAsync([
      'smoke',
      'fake-provider',
      '--model',
      'fake-model',
    ], { from: 'user' });

    expect(output).toEqual([
      'fake-model:ok',
      'Token：输入 2，输出 1，合计 3',
    ]);
  });
});
