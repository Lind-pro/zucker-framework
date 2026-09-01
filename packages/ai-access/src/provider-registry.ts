import type { AIAccessProviderPlugin } from './contracts';

export class AIAccessProviderRegistry {
  private readonly providers = new Map<string, AIAccessProviderPlugin>();

  register(provider: AIAccessProviderPlugin): void {
    if (!provider.id.trim() || !provider.name.trim()) {
      throw new Error('AI Access Provider 必须包含 id 和 name。');
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`AI Access Provider 已注册：${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): AIAccessProviderPlugin {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`AI Access Provider 不存在：${providerId}`);
    return provider;
  }

  list(): AIAccessProviderPlugin[] {
    return [...this.providers.values()];
  }
}
