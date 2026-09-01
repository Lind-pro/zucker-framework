import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIConfigService } from './config.service';

/** 构造一个最小可用的 DatabaseAdapter mock */
function makeDb(record: any) {
  return {
    model: vi.fn().mockReturnValue({
      findFirst: vi.fn().mockResolvedValue(record),
      findMany: vi.fn().mockResolvedValue(record ? [record] : []),
      findUnique: vi.fn().mockResolvedValue(record),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    }),
    $transaction: vi.fn(),
  } as any;
}

const baseRecord = {
  id: 'm-1',
  name: 'GPT-4o-mini',
  provider: 'OpenAI',
  modelId: 'gpt-4o-mini',
  apiKey: 'enc:abc123',
  baseUrl: null,
  temperature: 0.7,
  maxTokens: 4096,
  proxyHost: null,
  proxyPort: null,
  isEnabled: true,
  isDefault: true,
  scenarios: ['code-gen'],
};

describe('AIConfigService', () => {
  describe('apiKeyDecryptor 钩子（A2 反哺）', () => {
    let service: AIConfigService;

    beforeEach(() => {
      service = new AIConfigService(makeDb(baseRecord));
    });

    it('未注册解密器时，apiKey 原样返回（向后兼容）', async () => {
      const config = await service.getScenarioConfig('code-gen');
      expect(config.apiKey).toBe('enc:abc123');
    });

    it('注册同步解密器后，apiKey 被解密', async () => {
      service.setApiKeyDecryptor((s) => s.replace('enc:', 'plain-'));
      const config = await service.getScenarioConfig('code-gen');
      expect(config.apiKey).toBe('plain-abc123');
    });

    it('注册异步解密器后，apiKey 被异步解密', async () => {
      service.setApiKeyDecryptor(async (s) => {
        await new Promise((r) => setTimeout(r, 5));
        return `async-${s}`;
      });
      const config = await service.getScenarioConfig('code-gen');
      expect(config.apiKey).toBe('async-enc:abc123');
    });

    it('解密器抛错时错误传播（不静默使用密文）', async () => {
      service.setApiKeyDecryptor(() => {
        throw new Error('KMS 不可达');
      });
      await expect(service.getScenarioConfig('code-gen')).rejects.toThrow('KMS 不可达');
    });

    it('setApiKeyDecryptor(null) 清除钩子', async () => {
      service.setApiKeyDecryptor((s) => `decrypted-${s}`);
      service.setApiKeyDecryptor(null);
      const config = await service.getScenarioConfig('code-gen');
      expect(config.apiKey).toBe('enc:abc123');
    });

    it('缓存命中时不重复解密（性能验证）', async () => {
      const decryptor = vi.fn((s: string) => `D:${s}`);
      service.setApiKeyDecryptor(decryptor);

      await service.getScenarioConfig('code-gen');
      await service.getScenarioConfig('code-gen');
      await service.getScenarioConfig('code-gen');

      expect(decryptor).toHaveBeenCalledTimes(1);
    });

    it('clearCache() 后再次调用，重新解密', async () => {
      const decryptor = vi.fn((s: string) => `D:${s}`);
      service.setApiKeyDecryptor(decryptor);

      await service.getScenarioConfig('code-gen');
      service.clearCache();
      await service.getScenarioConfig('code-gen');

      expect(decryptor).toHaveBeenCalledTimes(2);
    });
  });
});
