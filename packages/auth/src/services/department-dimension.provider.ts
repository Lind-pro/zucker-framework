import { Injectable, Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker/core';
import type { DimensionProvider, DimensionType, Dimension } from '../interfaces';

/** Internal record shape for dimensions table */
interface DimensionRecord {
  id: string;
  name: string;
  typeId: string;
  path?: string;
}

/**
 * 内置的部门维度 Provider 示例
 * 基于 dimensions / dimensionUsers 表实现组织架构维度
 */
@Injectable()
export class DepartmentDimensionProvider implements DimensionProvider {
  readonly dimensionType = 'department';
  private readonly logger = new Logger(DepartmentDimensionProvider.name);

  constructor(private readonly db: DatabaseAdapter) {}

  async getAllTypes(): Promise<DimensionType[]> {
    const types = await this.db.model('dimensionTypes').findMany({}) as Array<{ id: string; name: string }>;
    return types.map((t) => ({
      id: t.id,
      name: t.name,
      isSameType: (other: DimensionType | string) => {
        const otherId = typeof other === 'string' ? other : other.id;
        return otherId === t.id;
      },
    }));
  }

  async getDimensionsByUserId(userId: string): Promise<Dimension[]> {
    const binds = await this.db.model('dimensionUsers').findMany({
      where: { userId },
    }) as Array<{ dimensionId: string }>;

    if (binds.length === 0) return [];

    const dimensionIds = binds.map((b) => b.dimensionId);
    const dimensions = await this.db.model('dimensions').findMany({
      where: { id: { in: dimensionIds } },
    }) as DimensionRecord[];

    return dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      type: {
        id: d.typeId,
        name: this.dimensionType,
        isSameType: (other: DimensionType | string) => {
          const otherId = typeof other === 'string' ? other : other.id;
          return otherId === d.typeId;
        },
      },
    }));
  }

  async getDimensionById(
    type: DimensionType,
    id: string,
  ): Promise<Dimension | null> {
    const dim = await this.db.model('dimensions').findUnique({
      where: { id },
    }) as DimensionRecord | null;
    if (!dim || dim.typeId !== type.id) return null;

    return {
      id: dim.id,
      name: dim.name,
      type,
    };
  }

  async getUserIdsByDimensionId(dimensionId: string): Promise<string[]> {
    const binds = await this.db.model('dimensionUsers').findMany({
      where: { dimensionId },
      select: { userId: true },
    }) as Array<{ userId: string }>;
    return binds.map((b) => b.userId);
  }

  /** 获取用户绑定的维度值列表 */
  async getDimensionValues(userId: string): Promise<string[]> {
    const binds = await this.db.model('dimensionUsers').findMany({
      where: { userId },
      select: { dimensionId: true },
    }) as Array<{ dimensionId: string }>;
    return binds.map((b) => b.dimensionId);
  }

  /** 级联展开：返回该维度节点及其所有子节点的 ID */
  async expandDimensionTree(value: string): Promise<string[]> {
    const result: string[] = [value];
    const node = await this.db.model('dimensions').findUnique({
      where: { id: value },
    }) as DimensionRecord | null;

    if (!node) return result;

    // 利用 path 前缀匹配查找所有子节点
    const path = node.path || value;
    const children = await this.db.model('dimensions').findMany({
      where: {
        path: { startsWith: `${path}/` },
      },
      select: { id: true },
    }) as Array<{ id: string }>;

    for (const child of children) {
      result.push(child.id);
    }

    return result;
  }
}
