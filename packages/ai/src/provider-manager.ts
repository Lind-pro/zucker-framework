import { Injectable, Logger } from '@nestjs/common';
import { ValidationException, NotFoundException } from '@zucker/core';
import { AIProvider } from './ai-provider.interface';

@Injectable()
export class AIProviderManager {
  private readonly logger = new Logger(AIProviderManager.name);
  private readonly providers = new Map<string, AIProvider>();
  private defaultProviderId: string | null = null;

  /**
   * 注册 AI Provider
   * @param provider AI Provider 实例
   * @throws ValidationException provider 缺少必要属性时
   */
  register(provider: AIProvider): void {
    if (!provider || !provider.id || !provider.name) {
      throw new ValidationException(
        { provider: ['AI Provider 必须包含 id 和 name 属性'] },
        'AI Provider 必须包含 id 和 name 属性',
      );
    }

    if (typeof provider.createModel !== 'function') {
      throw new ValidationException(
        { createModel: [`AI Provider '${provider.id}' 必须实现 createModel 方法`] },
        `AI Provider '${provider.id}' 必须实现 createModel 方法`,
      );
    }

    const isNew = !this.providers.has(provider.id);
    this.providers.set(provider.id, provider);

    if (!this.defaultProviderId) {
      this.defaultProviderId = provider.id;
    }

    this.logger.log(
      `AI Provider ${isNew ? '已注册' : '已更新'}: ${provider.id} (${provider.name})`,
    );
  }

  /** Unregister a provider. If the default provider is removed, the first remaining provider becomes default. */
  unregister(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    if (removed && this.defaultProviderId === providerId) {
      const firstKey = this.providers.keys().next().value;
      this.defaultProviderId = firstKey ?? null;
      if (this.defaultProviderId) {
        this.logger.log(`默认 AI Provider 已切换为: ${this.defaultProviderId}`);
      }
    }
    if (removed) {
      this.logger.log(`AI Provider 已注销: ${providerId}`);
    }
    return removed;
  }

  /**
   * 根据 ID 获取 AI Provider（不存在时抛出异常）
   * @param providerId Provider ID
   * @returns AI Provider 实例
   * @throws NotFoundException Provider 不存在时
   */
  get(providerId: string): AIProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      const available = [...this.providers.keys()].join(', ') || '(无)';
      throw new NotFoundException(`AI Provider '${providerId}' 不存在 (可用: ${available})`);
    }
    return provider;
  }

  /** Get a provider by ID, or undefined if not found */
  getOptional(providerId: string): AIProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * 获取默认 AI Provider
   * @returns 默认 AI Provider 实例
   * @throws NotFoundException 没有可用 Provider 时
   */
  getDefault(): AIProvider {
    if (!this.defaultProviderId) throw new NotFoundException('没有可用的 AI Provider');
    return this.get(this.defaultProviderId);
  }

  /** Get the default provider ID, or null if none is set */
  getDefaultId(): string | null {
    return this.defaultProviderId;
  }

  /**
   * 设置默认 AI Provider
   * @param providerId Provider ID
   * @throws NotFoundException Provider 不存在时
   */
  setDefault(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new NotFoundException(`AI Provider '${providerId}' 不存在`);
    }
    this.defaultProviderId = providerId;
    this.logger.log(`默认 AI Provider 已设置为: ${providerId}`);
  }

  /**
   * 获取所有已注册的 AI Provider
   * 对齐 ProviderRegistry.getAll() 命名规范
   */
  getAll(): AIProvider[] {
    return [...this.providers.values()];
  }

  /**
   * @deprecated 使用 getAll() 代替，保持与 ProviderRegistry 命名一致
   */
  list(): AIProvider[] {
    return this.getAll();
  }

  /** 检查指定 ID 的 Provider 是否已注册 */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /** Get the number of registered providers */
  get count(): number {
    return this.providers.size;
  }
}
