import { Injectable, Logger } from '@nestjs/common';
import { type TreeSortSupportEntity, type TreePathStrategy, list2tree, validateTreeEntity, ValidationException } from '@zucker-framework/core';
import { BaseService } from './base.service';
import { type DynamicQueryParam } from './dynamic-query.service';
import { type PaginatedResult, type SaveResult } from './pagination';
import { assertQueryField } from './query/query-policy';
import { EntityEventPhase, EntityEventType } from '@zucker-framework/event';

export interface TreeServiceOptions {
  /** 路径生成策略，默认使用节点 ID 作为路径段 */
  pathStrategy?: TreePathStrategy;
  /** 默认排序字段 */
  defaultOrderField?: string;
}

/**
 * Abstract service for tree-structured entities with automatic path/level management.
 * Extends BaseService with tree-specific operations: findAsTree, moveNode, rebuildPath, etc.
 *
 * @template T - The entity type, must extend TreeSortSupportEntity
 */
@Injectable()
export abstract class TreeService<T extends TreeSortSupportEntity> extends BaseService<T> {
  protected readonly treeLogger = new Logger(this.constructor.name);
  protected readonly pathStrategy?: TreePathStrategy;

  /**
   * 获取批量操作的缓冲大小
   */
  getBufferSize(): number {
    return 200;
  }

  /**
   * 设置子节点
   */
  setChildren(entity: T, children: T[]): void {
    (entity as TreeSortSupportEntity).children = children;
  }

  /**
   * 获取子节点
   */
  getChildren(entity: T): T[] {
    return ((entity as TreeSortSupportEntity).children ?? []) as T[];
  }

  /**
   * 查询所有数据并组装为树形结构
   */
  async findAsTree(): Promise<T[]> {
    const all = await this.db.model(this.modelName).findMany({
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as T[];
    return this.buildTree(all);
  }

  /**
   * 查询指定父节点下的所有子节点（直接子节点）
   */
  async findChildren(parentId: string): Promise<T[]> {
    return this.db.model(this.modelName).findMany({
      where: { parentId },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<T[]>;
  }

  /**
   * 查询节点及其所有后代（利用 path 前缀匹配）
   */
  async findWithChildren(id: string): Promise<T[]> {
    const node = await this.findOne(id);
    const path = node.path || id;

    return this.db.model(this.modelName).findMany({
      where: {
        OR: [
          { id },
          { path: { startsWith: `${path}/` } },
        ],
      },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<T[]>;
  }

  /**
   * 创建节点时自动计算 path、level 和 sortIndex
   */
  override async create(data: Partial<T>): Promise<T> {
    // 自动计算 sortIndex（同级内 max + 1）
    if (data.sortIndex === undefined) {
      data.sortIndex = await this.getNextSortIndex(data.parentId ?? null);
    }

    // 先创建节点获取 ID
    const result = await super.create(data);

    // 计算并更新 path 和 level（通过祖先链，避免全表扫描）
    const { path, level } = await this.computePathByAncestors(result.id, result.parentId);

    if (path !== result.path || level !== result.level) {
      await this.db.model(this.modelName).update({
        where: { id: result.id },
        data: { path, level },
      });
      (result as TreeSortSupportEntity).path = path;
      (result as TreeSortSupportEntity).level = level;
    }

    return result;
  }

  /**
   * 重建所有节点的 path 和 level 字段
   */
  async rebuildPath(): Promise<void> {
    const all = await this.db.model(this.modelName).findMany({
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as T[];

    const nodeMap = new Map<string, T>();
    for (const node of all) {
      nodeMap.set(node.id, node);
    }

    const updates: Promise<unknown>[] = [];
    for (const node of all) {
      const { path, level } = this.computePath(node, nodeMap);
      updates.push(
        this.db.model(this.modelName).update({
          where: { id: node.id },
          data: { path, level },
        }),
      );
    }

    await Promise.all(updates);
  }

  /**
   * 查询指定 ID 的实体及其所有后代节点
   * 使用 path 前缀匹配，并自动去重
   */
  async queryIncludeChildren(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];

    const nodes = await this.db.model(this.modelName).findMany({
      where: { id: { in: ids } },
    }) as T[];

    if (nodes.length === 0) return [];

    const seenIds = new Set<string>();
    const allResults: T[] = [];
    const duplicatePathCheck = new Set<string>();

    for (const node of nodes) {
      if (!node.path || duplicatePathCheck.has(node.path)) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          allResults.push(node);
        }
        continue;
      }
      duplicatePathCheck.add(node.path);

      // 使用 path 前缀快速查询所有后代
      const descendants = await this.db.model(this.modelName).findMany({
        where: {
          OR: [
            { id: node.id },
            { path: { startsWith: `${node.path}/` } },
          ],
        },
        orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
      }) as T[];

      for (const desc of descendants) {
        if (!seenIds.has(desc.id)) {
          seenIds.add(desc.id);
          allResults.push(desc);
        }
      }
    }

    return allResults;
  }

  /**
   * 根据查询参数查询数据，并包含所有匹配节点的子节点
   * 保留 includes/excludes 字段选择
   */
  async queryIncludeChildrenByQuery(queryParam: DynamicQueryParam): Promise<T[]> {
    const result = await this.findAll({ ...queryParam, page: undefined, pageSize: undefined }) as PaginatedResult<T>;
    const matchedData = result.data;

    if (matchedData.length === 0) return [];

    const seenIds = new Set<string>();
    const allResults: T[] = [];
    const duplicatePathCheck = new Set<string>();

    for (const node of matchedData) {
      if (!node.path || duplicatePathCheck.has(node.path)) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          allResults.push(node);
        }
        continue;
      }
      duplicatePathCheck.add(node.path);

      // 使用 path 前缀查询所有后代，保留 includes/excludes
      const includes = typeof queryParam.includes === 'string'
        ? (queryParam.includes as string).split(',').map((f) => f.trim()).filter(Boolean)
        : queryParam.includes;
      const selectFields: Record<string, boolean> | undefined =
        includes?.length
          ? Object.fromEntries(includes.map((f) => [assertQueryField(f, 'select', this.queryPolicy), true]))
          : undefined;

      const descendants = await this.db.model(this.modelName).findMany({
        where: {
          OR: [
            { id: node.id },
            { path: { startsWith: `${node.path}/` } },
          ],
        },
        orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
        ...(selectFields ? { select: selectFields } : {}),
      }) as T[];

      for (const desc of descendants) {
        if (!seenIds.has(desc.id)) {
          seenIds.add(desc.id);
          allResults.push(desc);
        }
      }
    }

    return allResults;
  }

  /**
   * 查询节点及所有后代（通过 path 前缀匹配）
   * @deprecated 使用 queryIncludeChildren() 代替
   */
  async findByTreeChild(parentIds: string[]): Promise<T[]> {
    if (parentIds.length === 0) return [];

    // 先获取所有父节点的 path
    const parents = await this.db.model(this.modelName).findMany({
      where: { id: { in: parentIds } },
    }) as T[];

    if (parents.length === 0) return [];

    const orConditions = parents.flatMap((p) => {
      const path = p.path || p.id;
      return [
        { id: p.id },
        { path: { startsWith: `${path}/` } },
      ];
    });

    return this.db.model(this.modelName).findMany({
      where: { OR: orConditions },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<T[]>;
  }

  /**
   * 向上查找所有祖先节点
   */
  async findParents(childId: string): Promise<T[]> {
    const node = await this.findOne(childId);
    if (!node.path) return [];

    const pathParts = node.path.split('/');
    // path 中最后一段是自身 ID，祖先是前面的部分
    const ancestorIds = pathParts.filter((id) => id !== childId);
    if (ancestorIds.length === 0) return [];

    return this.db.model(this.modelName).findMany({
      where: { id: { in: ancestorIds } },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<T[]>;
  }

  /**
   * 查找同级节点
   */
  async findSiblings(nodeId: string): Promise<T[]> {
    const node = await this.findOne(nodeId);
    return this.db.model(this.modelName).findMany({
      where: {
        parentId: node.parentId ?? null,
        NOT: { id: nodeId },
      },
      orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<T[]>;
  }

  /**
   * 查询指定 ID 节点的所有父/祖先节点（通过 path 反向匹配）
   */
  async queryIncludeParent(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];

    const nodes = await this.db.model(this.modelName).findMany({
      where: { id: { in: ids } },
    }) as T[];

    if (nodes.length === 0) return [];

    const seenIds = new Set<string>();
    const allResults: T[] = [];

    for (const node of nodes) {
      if (!node.path) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          allResults.push(node);
        }
        continue;
      }

      // 找到所有祖先：path 中包含的所有节点
      const pathParts = node.path.split('/');
      const ancestorIds = pathParts.filter((id) => !seenIds.has(id));
      if (ancestorIds.length > 0) {
        const ancestors = await this.db.model(this.modelName).findMany({
          where: { id: { in: ancestorIds } },
        }) as T[];
        for (const ancestor of ancestors) {
          if (!seenIds.has(ancestor.id)) {
            seenIds.add(ancestor.id);
            allResults.push(ancestor);
          }
        }
      }

      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        allResults.push(node);
      }
    }

    return allResults;
  }

  /**
   * 删除节点及其所有后代（通过 path 前缀匹配级联删除）
   * 通过路径前缀匹配级联删除子节点
   */
  override async delete(id: string): Promise<T> {
    const entity = await this.findOne(id);
    await this.emitPrepareAndBefore(EntityEventType.DELETE, entity);

    // 删除该节点及所有后代（通过 path 前缀匹配），在同一事务中执行
    await this.transaction(async () => {
      if (entity.path) {
        await this.db.model(this.modelName).deleteMany({
          where: this.scopeWhere({
            OR: [
              { id },
              { path: { startsWith: `${entity.path}/` } },
            ],
          }),
        });
      } else {
        await this.db.model(this.modelName).delete({ where: this.scopeWhere({ id }) });
      }
    });

    await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, entity);
    return entity;
  }

  /**
   * 更新节点。`path` / `level` 由服务维护，调用方传入的值会被忽略；
   * `parentId` 变化时经过循环校验并通过 {@link moveNode} 重算本节点及后代的 path/level，
   * 避免通用 PUT 路由造成 path 失效（随后按旧前缀级联删除会误删）。
   */
  override async update(id: string, data: Partial<T>): Promise<T> {
    const { path: _path, level: _level, ...rest } = data as Partial<T> & { path?: unknown; level?: unknown };
    void _path;
    void _level;
    if (!('parentId' in rest)) return super.update(id, rest as Partial<T>);

    const existing = await this.findOne(id);
    const nextParent = (rest.parentId as string | null | undefined) ?? null;
    const currentParent = existing.parentId ?? null;
    if (nextParent === currentParent) return super.update(id, rest as Partial<T>);

    await this.checkCyclicDependency(id, nextParent);
    return this.transaction(async () => {
      const { parentId: _parentId, ...fields } = rest as Partial<T> & { parentId?: unknown };
      void _parentId;
      if (Object.keys(fields).length > 0) await super.update(id, fields as Partial<T>);
      return this.moveNode(id, nextParent);
    });
  }

  /**
   * 批量删除节点及其后代
   */
  override async deleteBatch(ids: string[], options?: { skipEvents?: boolean }): Promise<number> {
    if (ids.length === 0) return 0;

    const nodes = await this.db.model(this.modelName).findMany({
      where: { id: { in: ids } },
    }) as T[];

    let totalDeleted = 0;
    for (const node of nodes) {
      if (node.path) {
        const result = await this.db.model(this.modelName).deleteMany({
          where: {
            OR: [
              { id: node.id },
              { path: { startsWith: `${node.path}/` } },
            ],
          },
        });
        totalDeleted += result.count;
      } else {
        await this.db.model(this.modelName).delete({ where: { id: node.id } }).catch(() => {});
        totalDeleted += 1;
      }
    }

    return totalDeleted;
  }

  /**
   * 保存/更新时自动处理树属性
   * - 校验循环依赖
   * - 展开子节点
   * - 自动分配 path, level, sortIndex
   */
  override async save(entities: Partial<T>[]): Promise<SaveResult> {
    // 展开树形数据：如果传入的 entity 带有 children，先展平为列表
    // 将树形输入展开为列表并填充路径
    const flattened = this.expandTreeToList(entities);

    let created = 0;
    let updated = 0;

    for (const entity of flattened) {
      // 校验 parentId != id
      if (entity.id && entity.parentId) {
        validateTreeEntity(entity as TreeSortSupportEntity);
      }

      // 如果有 parentId 但没有 path，需要从父节点继承
      if (entity.parentId && !entity.path && entity.parentId !== '-1') {
        const parent = await this.findByIdOptional(entity.parentId);
        if (parent?.path) {
          entity.path = `${parent.path}/${entity.id ?? ''}`;
        }
      }

      const id = entity.id;
      if (id) {
        const existing = await this.db.model(this.modelName).findUnique({ where: { id } }).catch(() => null);
        if (existing) {
          // 如果 parentId 发生变化，校验循环依赖
          if (entity.parentId !== undefined && entity.parentId !== (existing as T).parentId) {
            await this.checkCyclicDependency(id, entity.parentId ?? null);
          }
          await this.update(id, entity);
          updated++;
        } else {
          await this.create(entity);
          created++;
        }
      } else {
        await this.create(entity);
        created++;
      }
    }

    return { created, updated, total: created + updated };
  }

  /**
   * 查询并返回树形结构（使用查询参数）
   */
  async queryResultToTree(queryParam?: DynamicQueryParam): Promise<T[]> {
    let all: T[];
    if (queryParam) {
      // 查询后组装为树（先查后组装）
      const result = await this.findAll({ ...queryParam, page: undefined, pageSize: undefined }) as PaginatedResult<T>;
      all = result.data;
    } else {
      all = await this.db.model(this.modelName).findMany({
        orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
      }) as T[];
    }

    return list2tree(all, {
      idField: 'id',
      parentIdField: 'parentId',
      childrenField: 'children',
    }) as T[];
  }

  // NOTE: The following duplicate methods were removed in convergence review 3.
  // queryIncludeChildren(DynamicQueryParam) → use queryIncludeChildrenByQuery() instead
  // queryIncludeParent(string[]) duplicate → already defined above at the first occurrence

  /**
   * 查询符合条件的数据及其所有子节点，组装为树
   */
  async queryIncludeChildrenTree(queryParam: DynamicQueryParam): Promise<T[]> {
    const matched = await this.findAll({ ...queryParam, page: undefined, pageSize: undefined }) as PaginatedResult<T>;
    const matchedData = matched.data;

    if (matchedData.length === 0) return [];

    // 对每个匹配的节点，查询其所有后代
    const allDescendants: T[] = [];
    const seenIds = new Set<string>();
    for (const node of matchedData) {
      const withChildren = await this.findWithChildren(node.id);
      for (const child of withChildren) {
        if (!seenIds.has(child.id)) {
          seenIds.add(child.id);
          allDescendants.push(child);
        }
      }
    }

    return list2tree(allDescendants, {
      idField: 'id',
      parentIdField: 'parentId',
      childrenField: 'children',
    }) as T[];
  }

  /**
   * 校验循环依赖
   * 防止将节点的父节点设置为自己的子节点
   */
  async checkCyclicDependency(nodeId: string, newParentId: string | null): Promise<void> {
    if (!newParentId || nodeId === newParentId) {
      if (nodeId === newParentId) {
        throw new ValidationException(
          { parentId: ['不能将节点的父节点设置为自身'] },
          '不能将节点的父节点设置为自身',
        );
      }
      return;
    }

    // 查询 nodeId 的所有后代
    const descendants = await this.findWithChildren(nodeId);
    for (const desc of descendants) {
      if (desc.id === newParentId) {
        throw new ValidationException(
          { parentId: ['不能修改父节点为自己或者自己的子节点'] },
          '不能修改父节点为自己或者自己的子节点',
        );
      }
    }
  }

  /**
   * 判断节点是否为根节点
   */
  isRootNode(entity: T): boolean {
    return !entity.parentId || entity.parentId === '-1';
  }

  /**
   * 移动节点到新的父节点下
   */
  async moveNode(id: string, newParentId: string | null): Promise<T> {
    // 校验循环依赖
    await this.checkCyclicDependency(id, newParentId);
    // Parent change and path/level rewrite of the subtree commit together.
    return this.transaction(() => this.moveNodeInTransaction(id, newParentId));
  }

  private async moveNodeInTransaction(id: string, newParentId: string | null): Promise<T> {
    const node = await this.findOne(id);

    // 自动分配新的 sortIndex
    const newSortIndex = await this.getNextSortIndex(newParentId);

    const result = await this.db.model(this.modelName).update({
      where: { id },
      data: { parentId: newParentId, sortIndex: newSortIndex },
    }) as T;

    // 重建该节点及其后代的 path（仅加载后代节点，通过祖先链计算路径）
    const descendants = await this.findWithChildren(id);
    const descMap = new Map<string, T>();
    for (const d of descendants) {
      if (d.id === id) {
        d.parentId = newParentId;
      }
      descMap.set(d.id, d);
    }

    // 预计算移动节点的祖先路径前缀
    const { path: rootPath, level: rootLevel } = await this.computePathByAncestors(id, newParentId);

    const updates: Array<{ id: string; path: string; level: number }> = [];
    for (const desc of descendants) {
      let path: string;
      let level: number;
      if (desc.id === id) {
        path = rootPath;
        level = rootLevel;
      } else {
        // 对后代节点，通过 descMap 向上找到移动的根节点，再拼接祖先路径
        const parts: string[] = [];
        let cur: T | undefined = desc;
        const visited = new Set<string>();
        while (cur?.parentId) {
          if (visited.has(cur.parentId)) break;
          visited.add(cur.parentId);
          const parent = descMap.get(cur.parentId);
          if (!parent) break;
          parts.unshift(parent.id);
          cur = parent;
        }
        // parts 现在包含从移动根节点到 desc 父节点的 ID
        // 祖先前缀 = rootPath 去掉最后的 id 段
        const ancestorPrefix = rootPath.substring(0, rootPath.lastIndexOf('/'));
        const fullParts = ancestorPrefix ? [ancestorPrefix, ...parts, desc.id] : [...parts, desc.id];
        path = fullParts.join('/');
        level = path.split('/').length - 1;
      }
      updates.push({ id: desc.id, path, level });
    }
    // Sequential: interactive transactions run one statement at a time.
    for (const update of updates) {
      await this.db.model(this.modelName).update({
        where: { id: update.id },
        data: { path: update.path, level: update.level },
      });
    }

    return result;
  }

  /**
   * 获取同级节点的下一个 sortIndex
   */
  protected async getNextSortIndex(parentId: string | null): Promise<number> {
    const siblings = await this.db.model(this.modelName).findMany({
      where: parentId ? { parentId } : { parentId: null },
      orderBy: [{ sortIndex: 'desc' }],
    }) as T[];

    if (siblings.length === 0) return 1;
    return (siblings[0].sortIndex ?? 0) + 1;
  }

  /**
   * 展开树形输入数据为扁平列表
   * 递归遍历 children 字段，将嵌套树结构展平
   */
  private expandTreeToList(entities: Partial<T>[]): Partial<T>[] {
    const result: Partial<T>[] = [];

    const expand = (items: Partial<T>[], parentId?: string | null) => {
      for (const item of items) {
        const children = (item as Record<string, unknown>).children as Partial<T>[] | undefined;

        // 设置 parentId（如果有父节点且当前节点没有设置）
        if (parentId !== undefined && !item.parentId) {
          item.parentId = parentId;
        }

        // 清除 children 字段（不存入数据库）
        delete (item as Record<string, unknown>).children;

        result.push(item);

        // 递归展开子节点
        if (children && children.length > 0) {
          expand(children, item.id ?? null);
        }
      }
    };

    expand(entities);
    return result;
  }

  private buildTree(nodes: T[], parentId: string | null = null): T[] {
    const result: T[] = [];

    for (const node of nodes) {
      const nodeParentId = node.parentId ?? null;
      if (nodeParentId === parentId) {
        const children = this.buildTree(nodes, node.id);
        if (children.length > 0) {
          (node as TreeSortSupportEntity).children = children;
        }
        result.push(node);
      }
    }

    return result;
  }

  /**
   * 通过向上遍历祖先链计算 path 和 level，避免加载全表。
   */
  private async computePathByAncestors(nodeId: string, parentId: string | null | undefined): Promise<{ path: string; level: number }> {
    const parts: string[] = [];
    let currentParentId = parentId;
    const visited = new Set<string>();

    while (currentParentId) {
      if (visited.has(currentParentId)) break;
      visited.add(currentParentId);
      const parent = await this.db.model(this.modelName).findUnique({
        where: { id: currentParentId },
      }) as T | null;
      if (!parent) break;
      parts.unshift(parent.id);
      currentParentId = parent.parentId;
    }

    parts.push(nodeId);
    return {
      path: parts.join('/'),
      level: parts.length - 1,
    };
  }

  private computePath(node: T, nodeMap: Map<string, T>): { path: string; level: number } {
    const parts: string[] = [];
    let current: T | undefined = node;
    const visited = new Set<string>();

    while (current?.parentId) {
      if (visited.has(current.parentId)) break;
      visited.add(current.parentId);
      const parent = nodeMap.get(current.parentId);
      if (!parent) break;
      parts.unshift(parent.id);
      current = parent;
    }

    parts.push(node.id);
    return {
      path: parts.join('/'),
      level: parts.length - 1,
    };
  }
}
