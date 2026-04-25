import { Injectable, Logger } from '@nestjs/common';
import { DefaultProviderRegistry, Disposable, Provider, ProviderRegistry } from './provider-registry';

/**
 * 支持 fallback 的 ProviderRegistry — 在找不到指定 provider 时，
 * 按备选 ID 列表依次查找，或返回默认 provider。
 */
@Injectable()
export class FallbackProviderRegistry<T> implements ProviderRegistry<T> {
  private readonly logger = new Logger(FallbackProviderRegistry.name);
  private readonly delegate = new DefaultProviderRegistry<T>();

  register(provider: Provider<T>): Disposable {
    return this.delegate.register(provider);
  }

  unregister(id: string): void {
    this.delegate.unregister(id);
  }

  get(id: string): Provider<T> | undefined {
    return this.delegate.get(id);
  }

  getNow(id: string): Provider<T> {
    return this.delegate.getNow(id);
  }

  registerIfAbsent(provider: Provider<T>): Provider<T> | undefined {
    return this.delegate.registerIfAbsent(provider);
  }

  registerIfAbsentWith(id: string, builder: (id: string) => Provider<T>): Provider<T> | undefined {
    return this.delegate.registerIfAbsentWith(id, builder);
  }

  getAll(): Provider<T>[] {
    return this.delegate.getAll();
  }

  getDefault(): Provider<T> | undefined {
    return this.delegate.getDefault();
  }

  setDefault(id: string): void {
    this.delegate.setDefault(id);
  }

  /**
   * 按序查找 provider：先找主 ID，找不到则依次尝试 fallback ID 列表
   */
  getWithFallback(id: string, ...fallbackIds: string[]): Provider<T> | undefined {
    const primary = this.delegate.get(id);
    if (primary) return primary;

    for (const fallbackId of fallbackIds) {
      const fallback = this.delegate.get(fallbackId);
      if (fallback) {
        this.logger.debug(`Provider '${id}' not found, using fallback '${fallbackId}'`);
        return fallback;
      }
    }

    this.logger.debug(`Provider '${id}' and all fallbacks not found`);
    return undefined;
  }

  /**
   * 找不到指定 ID 的 provider 时返回默认 provider
   */
  getOrDefault(id: string): Provider<T> | undefined {
    return this.delegate.get(id) ?? this.delegate.getDefault();
  }
}
