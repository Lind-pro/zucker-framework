import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekProvider } from './deepseek.provider';

describe('DeepSeekProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  describe('身份', () => {
    it('id 应为 deepseek', () => {
      const provider = new DeepSeekProvider();
      expect(provider.id).toBe('deepseek');
    });

    it('name 应为 DeepSeek', () => {
      const provider = new DeepSeekProvider();
      expect(provider.name).toBe('DeepSeek');
    });
  });

  describe('createModel', () => {
    it('成功路径：返回构造好的 OpenAI 客户端实例', async () => {
      const ctorSpy = vi.fn();
      const FakeOpenAI = class {
        constructor(opts: any) {
          ctorSpy(opts);
        }
      };

      vi.doMock('openai', () => ({
        default: FakeOpenAI,
        OpenAI: FakeOpenAI,
      }));

      const { DeepSeekProvider: Provider } = await import('./deepseek.provider');
      const provider = new Provider();
      const client = await provider.createModel({
        apiKey: 'sk-test',
        modelId: 'deepseek-chat',
        timeoutMs: 30000,
      });

      expect(client).toBeInstanceOf(FakeOpenAI);
      expect(ctorSpy).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        timeout: 30000,
      });
    });

    it('自定义 baseURL 应覆盖默认值', async () => {
      const ctorSpy = vi.fn();
      const FakeOpenAI = class {
        constructor(opts: any) {
          ctorSpy(opts);
        }
      };

      vi.doMock('openai', () => ({
        default: FakeOpenAI,
        OpenAI: FakeOpenAI,
      }));

      const { DeepSeekProvider: Provider } = await import('./deepseek.provider');
      const provider = new Provider();
      await provider.createModel({
        apiKey: 'sk-test',
        modelId: 'deepseek-chat',
        baseURL: 'https://custom.deepseek.example.com/v1',
      });

      expect(ctorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://custom.deepseek.example.com/v1',
        }),
      );
    });

    it('未提供 baseURL 时使用 DeepSeek 官方默认', async () => {
      const ctorSpy = vi.fn();
      const FakeOpenAI = class {
        constructor(opts: any) {
          ctorSpy(opts);
        }
      };

      vi.doMock('openai', () => ({
        default: FakeOpenAI,
        OpenAI: FakeOpenAI,
      }));

      const { DeepSeekProvider: Provider } = await import('./deepseek.provider');
      const provider = new Provider();
      await provider.createModel({ apiKey: 'sk-test', modelId: 'deepseek-chat' });

      expect(ctorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.deepseek.com/v1',
        }),
      );
    });

    it('openai 包缺失时抛出友好错误', async () => {
      vi.doMock('openai', () => {
        throw new Error('Cannot find module openai');
      });

      const { DeepSeekProvider: Provider } = await import('./deepseek.provider');
      const provider = new Provider();

      await expect(
        provider.createModel({ apiKey: 'sk-test', modelId: 'deepseek-chat' }),
      ).rejects.toThrow(/openai package not installed/);
    });
  });
});
