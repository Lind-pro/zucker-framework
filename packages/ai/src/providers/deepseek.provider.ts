import type { AIProvider, AIModelConfig } from '../ai-provider.interface';

/**
 * DeepSeek Provider 适配器。
 *
 * DeepSeek API 与 OpenAI Chat Completions 完全兼容，因此直接复用 openai 包，
 * 仅 baseURL 默认值不同。使用者需自行安装 openai 包：npm install openai
 */
export class DeepSeekProvider implements AIProvider {
  id = 'deepseek';
  name = 'DeepSeek';

  async createModel(config: AIModelConfig): Promise<unknown> {
    try {
      // 使用变量名 + Vite-ignore 注释，避免构建/测试工具静态解析 'openai' 导致
      // "Failed to resolve import" 错误（运行时由消费方安装 openai 包）。
      const packageName = 'openai';
      const mod = await import(/* @vite-ignore */ packageName);
      const OpenAI = mod.default ?? mod.OpenAI;
      return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? 'https://api.deepseek.com/v1',
        timeout: config.timeoutMs,
      });
    } catch {
      throw new Error('openai package not installed. Run: npm install openai');
    }
  }
}
