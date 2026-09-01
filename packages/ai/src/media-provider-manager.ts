import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException, ValidationException } from '@zucker/core';
import { MediaType, type MediaProvider } from './media.interface';

/**
 * 媒体生成 Provider 管理器
 * 管理图片/视频/音频生成 provider 的注册、发现和选择
 */
@Injectable()
export class MediaProviderManager {
  private readonly logger = new Logger(MediaProviderManager.name);
  private readonly providers = new Map<string, MediaProvider>();
  private defaultProviderId: string | null = null;

  /** 注册 provider */
  register(provider: MediaProvider): void {
    if (!provider?.id || !provider?.name) {
      throw new ValidationException(
        { provider: ['MediaProvider 必须包含 id 和 name 属性'] },
        'MediaProvider 必须包含 id 和 name 属性',
      );
    }

    if (typeof provider.generate !== 'function') {
      throw new ValidationException(
        { generate: [`MediaProvider '${provider.id}' 必须实现 generate 方法`] },
        `MediaProvider '${provider.id}' 必须实现 generate 方法`,
      );
    }

    if (!Array.isArray(provider.supportedTypes) || provider.supportedTypes.length === 0) {
      throw new ValidationException(
        { supportedTypes: [`MediaProvider '${provider.id}' 必须声明 supportedTypes`] },
        `MediaProvider '${provider.id}' 必须声明 supportedTypes`,
      );
    }

    const isNew = !this.providers.has(provider.id);
    this.providers.set(provider.id, provider);

    if (!this.defaultProviderId) {
      this.defaultProviderId = provider.id;
    }

    const types = provider.supportedTypes.join(', ');
    this.logger.log(
      `MediaProvider ${isNew ? '已注册' : '已更新'}: ${provider.id} (${provider.name}) [${types}]`,
    );
  }

  /** 注销 provider */
  unregister(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    if (removed && this.defaultProviderId === providerId) {
      const firstKey = this.providers.keys().next().value;
      this.defaultProviderId = firstKey ?? null;
      if (this.defaultProviderId) {
        this.logger.log(`默认 MediaProvider 已切换为: ${this.defaultProviderId}`);
      }
    }
    if (removed) {
      this.logger.log(`MediaProvider 已注销: ${providerId}`);
    }
    return removed;
  }

  /** 获取指定 provider，不存在则抛异常 */
  get(providerId: string): MediaProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      const available = [...this.providers.keys()].join(', ') || '(无)';
      throw new NotFoundException(`MediaProvider '${providerId}' 不存在 (可用: ${available})`);
    }
    return provider;
  }

  /** 获取指定 provider，不存在返回 undefined */
  getOptional(providerId: string): MediaProvider | undefined {
    return this.providers.get(providerId);
  }

  /** 获取默认 provider */
  getDefault(): MediaProvider {
    if (!this.defaultProviderId) {
      throw new NotFoundException('没有可用的 MediaProvider');
    }
    return this.get(this.defaultProviderId);
  }

  /** 获取默认 provider ID */
  getDefaultId(): string | null {
    return this.defaultProviderId;
  }

  /** 设置默认 provider */
  setDefault(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new NotFoundException(`MediaProvider '${providerId}' 不存在`);
    }
    this.defaultProviderId = providerId;
    this.logger.log(`默认 MediaProvider 已设置为: ${providerId}`);
  }

  /** 按媒体类型筛选可用 provider */
  getByMediaType(type: MediaType): MediaProvider[] {
    return [...this.providers.values()].filter((p) => p.supportedTypes.includes(type));
  }

  /** 获取所有 provider */
  getAll(): MediaProvider[] {
    return [...this.providers.values()];
  }

  /** 检查 provider 是否存在 */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /** 已注册 provider 数量 */
  get count(): number {
    return this.providers.size;
  }
}
