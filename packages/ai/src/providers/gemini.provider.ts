import type { AIProvider, AIModelConfig } from '../ai-provider.interface';

/**
 * Google Gemini Provider 适配器。
 * 使用者需自行安装 @google/generative-ai 包：npm install @google/generative-ai
 */
export class GeminiProvider implements AIProvider {
  id = 'gemini';
  name = 'Google Gemini';

  async createModel(config: AIModelConfig): Promise<unknown> {
    // 延迟动态导入，ESM/CJS 双兼容
    try {
      const mod = await import('@google/generative-ai' as string);
      const GoogleGenerativeAI = mod.GoogleGenerativeAI;
      const genAI = new GoogleGenerativeAI(config.apiKey);
      return genAI.getGenerativeModel({ model: config.modelId });
    } catch {
      throw new Error('@google/generative-ai package not installed. Run: npm install @google/generative-ai');
    }
  }
}
