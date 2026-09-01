import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@zucker/core';

/**
 * 资源提供者 SPI
 */
export interface ResourceProvider {
  /** 获取资源类型标识 */
  getType(): string;
  /** 根据 ID 获取资源实例 */
  getResource(id: string): Promise<unknown>;
  /** 列出所有可用资源 ID */
  listResources?(): Promise<string[]>;
}

/**
 * 资源管理器 — 按 type + id 获取资源
 */
@Injectable()
export class ResourceManager {
  private readonly logger = new Logger(ResourceManager.name);
  private providers = new Map<string, ResourceProvider>();

  /** 注册资源提供者 */
  registerProvider(provider: ResourceProvider): void {
    this.providers.set(provider.getType(), provider);
    this.logger.log(`Resource provider registered: ${provider.getType()}`);
  }

  /** 注销资源提供者 */
  unregisterProvider(type: string): void {
    this.providers.delete(type);
  }

  /**
   * 根据类型和 ID 获取资源（不存在时返回 undefined）
   * @param type 资源类型
   * @param id 资源 ID
   * @returns 资源实例或 undefined
   */
  async getResource<T = unknown>(type: string, id: string): Promise<T | undefined> {
    const provider = this.providers.get(type);
    if (!provider) return undefined;
    return provider.getResource(id) as Promise<T | undefined>;
  }

  /**
   * 根据类型和 ID 获取资源（不存在时抛出 NotFoundException）
   * @param type 资源类型
   * @param id 资源 ID
   * @returns 资源实例
   * @throws NotFoundException 资源不存在时
   */
  async getResourceOrThrow<T = unknown>(type: string, id: string): Promise<T> {
    const resource = await this.getResource<T>(type, id);
    if (resource === undefined || resource === null) {
      throw new NotFoundException(`Resource not found: ${type}/${id}`);
    }
    return resource;
  }

  /** 获取指定类型的资源提供者 */
  getProvider(type: string): ResourceProvider | undefined {
    return this.providers.get(type);
  }

  /** 获取所有已注册的资源类型 */
  getTypes(): string[] {
    return Array.from(this.providers.keys());
  }
}
