import { describe, expect, it, vi } from 'vitest';
import type { AIAccessProviderPlugin } from './contracts';
import { AIAccessProviderRegistry } from './provider-registry';

const provider = (id: string): AIAccessProviderPlugin => ({
  id,
  name: `Provider ${id}`,
  authMethods: [
    {
      id: 'fake-login',
      label: 'Fake login',
      kind: 'custom',
      login: vi.fn(),
    },
  ],
  credentialSources: [],
  runtime: { complete: vi.fn() },
});

describe('AIAccessProviderRegistry', () => {
  it('注册任意 Provider 后可以按 id 获取', () => {
    const registry = new AIAccessProviderRegistry();
    const fakeClaude = provider('fake-claude');

    registry.register(fakeClaude);

    expect(registry.get('fake-claude')).toBe(fakeClaude);
    expect(registry.list()).toEqual([fakeClaude]);
  });

  it('重复注册同一 Provider 时失败', () => {
    const registry = new AIAccessProviderRegistry();
    registry.register(provider('duplicate'));

    expect(() => registry.register(provider('duplicate'))).toThrow('已注册');
  });

  it('未知 Provider 返回明确错误', () => {
    expect(() => new AIAccessProviderRegistry().get('missing')).toThrow('不存在');
  });
});
