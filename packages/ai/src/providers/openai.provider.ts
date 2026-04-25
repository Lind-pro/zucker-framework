import type { AIProvider, AIModelConfig } from '../ai-provider.interface';

/**
 * OpenAI Provider 适配器。
 * 使用者需自行安装 openai 包：npm install openai
 */
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  name = 'OpenAI';

  async createModel(config: AIModelConfig): Promise<unknown> {
    // 延迟动态导入，ESM/CJS 双兼容
    try {
      const mod = await import('openai' as string);
      const OpenAI = mod.default ?? mod.OpenAI;
      return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: config.timeoutMs,
      });
    } catch {
      throw new Error('openai package not installed. Run: npm install openai');
    }
  }
}
