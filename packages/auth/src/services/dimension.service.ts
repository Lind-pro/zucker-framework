import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { DimensionProvider, Dimension, DimensionType } from '../interfaces';
import { DIMENSION_PROVIDERS } from '../interfaces';

/**
 * 维度服务注册中心
 * 管理多个 DimensionProvider，按 dimensionType 索引
 */
@Injectable()
export class DimensionService {
  private readonly logger = new Logger(DimensionService.name);
  private readonly providerMap = new Map<string, DimensionProvider>();

  constructor(
    @Optional()
    @Inject(DIMENSION_PROVIDERS)
    private readonly providers: DimensionProvider[] | null,
  ) {
    // 按 dimensionType 建立索引
    if (this.providers?.length) {
      for (const provider of this.providers) {
        if (provider.dimensionType) {
          this.providerMap.set(provider.dimensionType, provider);
        }
      }
      this.logger.log(
        `已注册 ${this.providerMap.size} 个维度 Provider: ${Array.from(this.providerMap.keys()).join(', ')}`,
      );
    }
  }

  /** 注册新的维度 Provider */
  registerProvider(provider: DimensionProvider): void {
    this.providerMap.set(provider.dimensionType, provider);
    this.logger.log(`注册维度 Provider: ${provider.dimensionType}`);
  }

  /** 获取指定类型的 Provider */
  getProvider(dimensionType: string): DimensionProvider | undefined {
    return this.providerMap.get(dimensionType);
  }

  /** 获取所有已注册的 Provider */
  getAllProviders(): DimensionProvider[] {
    return Array.from(this.providerMap.values());
  }

  async getUserDimensions(userId: string): Promise<Dimension[]> {
    const allProviders = this.getActiveProviders();
    if (allProviders.length === 0) return [];

    const results = await Promise.all(
      allProviders.map((p) => p.getDimensionsByUserId(userId)),
    );
    return results.flat();
  }

  /** 获取用户在指定维度类型下的值 */
  async getUserDimensionValues(
    userId: string,
    dimensionType: string,
  ): Promise<string[]> {
    const provider = this.providerMap.get(dimensionType);
    if (!provider) return [];
    return provider.getDimensionValues(userId);
  }

  /** 级联展开维度树 */
  async expandDimensionTree(
    dimensionType: string,
    value: string,
  ): Promise<string[]> {
    const provider = this.providerMap.get(dimensionType);
    if (!provider) return [value];
    return provider.expandDimensionTree(value);
  }

  /** 获取用户在所有维度的完整展开值集合 */
  async getExpandedUserDimensions(
    userId: string,
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const allProviders = this.getActiveProviders();

    for (const provider of allProviders) {
      const values = await provider.getDimensionValues(userId);
      const expanded = new Set<string>();

      for (const value of values) {
        const tree = await provider.expandDimensionTree(value);
        tree.forEach((v) => expanded.add(v));
      }

      result.set(provider.dimensionType, Array.from(expanded));
    }

    return result;
  }

  async hasDimension(
    userId: string,
    dimensionType: string,
    dimensionId: string,
  ): Promise<boolean> {
    const provider = this.providerMap.get(dimensionType);
    if (provider) {
      const values = await provider.getDimensionValues(userId);
      if (values.includes(dimensionId)) return true;
      // 检查级联展开
      for (const v of values) {
        const expanded = await provider.expandDimensionTree(v);
        if (expanded.includes(dimensionId)) return true;
      }
      return false;
    }

    // 回退到所有 provider
    const dimensions = await this.getUserDimensions(userId);
    return dimensions.some(
      (d) => d.type.id === dimensionType && d.id === dimensionId,
    );
  }

  async getAllDimensionTypes(): Promise<DimensionType[]> {
    const allProviders = this.getActiveProviders();
    if (allProviders.length === 0) return [];

    const results = await Promise.all(
      allProviders.map((p) => p.getAllTypes()),
    );
    return results.flat();
  }

  async getDimensionById(
    type: DimensionType,
    id: string,
  ): Promise<Dimension | null> {
    const allProviders = this.getActiveProviders();
    for (const provider of allProviders) {
      const dimension = await provider.getDimensionById(type, id);
      if (dimension) return dimension;
    }
    return null;
  }

  async getUserIdsByDimensionId(dimensionId: string): Promise<string[]> {
    const allProviders = this.getActiveProviders();
    if (allProviders.length === 0) return [];

    const results = await Promise.all(
      allProviders.map((p) => p.getUserIdsByDimensionId(dimensionId)),
    );
    return [...new Set(results.flat())];
  }

  private getActiveProviders(): DimensionProvider[] {
    if (this.providerMap.size > 0) {
      return Array.from(this.providerMap.values());
    }
    return this.providers || [];
  }
}
