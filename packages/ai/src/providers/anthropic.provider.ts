import type { AIProvider, AIModelConfig } from '../ai-provider.interface';

/**
 * Anthropic Provider 适配器。
 * 使用者需自行安装 @anthropic-ai/sdk 包：npm install @anthropic-ai/sdk
 */
export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  name = 'Anthropic';

  async createModel(config: AIModelConfig): Promise<unknown> {
    // 延迟动态导入，ESM/CJS 双兼容
    try {
      const mod = await import('@anthropic-ai/sdk' as string);
      const Anthropic = mod.default ?? mod.Anthropic;
      return new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: config.timeoutMs,
      });
    } catch {
      throw new Error('@anthropic-ai/sdk package not installed. Run: npm install @anthropic-ai/sdk');
    }
  }
}
