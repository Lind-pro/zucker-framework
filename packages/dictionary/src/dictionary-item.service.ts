import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter } from '@zucker-framework/core';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
import type { DictionaryItem } from './index';
import { ClearDictionaryCacheEvent } from './clear-dictionary-cache-event';

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

export interface TreeNode {
  id: string;
  name: string;
  value: string;
  text: string;
  parentId: string | null;
  sortIndex: number;
  description?: string;
  status?: boolean;
  properties?: Record<string, unknown>;
  children: TreeNode[];
}

@Injectable()
export class DictionaryItemService {
  private readonly logger = new Logger(DictionaryItemService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Return all dictionary items, optionally filtered by dictId.
   * Used by admin endpoints for cross-dictionary queries.
   */
  async findAll(filter?: { dictId?: string }): Promise<DictionaryItem[]> {
    const where: Record<string, unknown> = {};
    if (filter?.dictId) where.dictId = filter.dictId;
    return this.db.model('dictionaryItem').findMany({
      where,
      orderBy: { sortIndex: 'asc' },
    }) as Promise<DictionaryItem[]>;
  }

  async findByDictId(dictId: string): Promise<DictionaryItem[]> {
    return this.db.model('dictionaryItem').findMany({
      where: { dictId },
      orderBy: { sortIndex: 'asc' },
    }) as Promise<DictionaryItem[]>;
  }

  async getTree(dictId: string): Promise<TreeNode[]> {
    const items = await this.findByDictId(dictId);
    return this.buildTree(items);
  }

  async create(data: {
    dictId: string;
    name: string;
    value: string;
    text: string;
    parentId?: string;
    sortIndex?: number;
    description?: string;
    status?: boolean;
    properties?: Record<string, unknown>;
    searchCode?: string;
    valueType?: string;
  }): Promise<DictionaryItem> {
    const path = data.parentId
      ? await this.buildPath(data.parentId)
      : '';

    // Auto-fill ordinal if not provided
    let ordinal = data.sortIndex;
    if (ordinal === undefined || ordinal === null) {
      ordinal = await this.nextOrdinal(data.dictId);
    }

    const result = await this.db.model('dictionaryItem').create({
      data: {
        ...data,
        path,
        ordinal,
      },
    }) as DictionaryItem;
    this.emitCacheClear();
    return result;
  }

  /**
   * Batch create items, auto-filling ordinals for items that don't have one.
   */
  async createBatch(items: Array<{
    dictId: string;
    name: string;
    value: string;
    text: string;
    parentId?: string;
    sortIndex?: number;
    description?: string;
    status?: boolean;
    properties?: Record<string, unknown>;
    searchCode?: string;
    valueType?: string;
  }>): Promise<DictionaryItem[]> {
    // Group by dictId for ordinal assignment
    const byDictId = new Map<string, typeof items>();
    for (const item of items) {
      const list = byDictId.get(item.dictId) ?? [];
      list.push(item);
      byDictId.set(item.dictId, list);
    }

    const results: DictionaryItem[] = [];
    for (const [dictId, group] of byDictId) {
      const allHaveOrdinal = group.every((i) => i.sortIndex !== undefined && i.sortIndex !== null);
      const noneHaveOrdinal = group.every((i) => i.sortIndex === undefined || i.sortIndex === null);

      if (!allHaveOrdinal && !noneHaveOrdinal) {
        throw new Error('Within a batch for the same dictId, all items must have sortIndex or none must');
      }

      let nextOrd = 0;
      if (noneHaveOrdinal) {
        nextOrd = await this.nextOrdinal(dictId);
      }

      for (const item of group) {
        const ordinal = allHaveOrdinal ? item.sortIndex! : nextOrd++;
        const path = item.parentId ? await this.buildPath(item.parentId) : '';
        const created = (await this.db.model('dictionaryItem').create({
          data: { ...item, path, ordinal },
        })) as DictionaryItem;
        results.push(created);
      }
    }

    this.emitCacheClear();
    return results;
  }

  /**
   * Find items by search code (fuzzy/quick lookup).
   */
  async findBySearchCode(dictId: string, searchCode: string): Promise<DictionaryItem[]> {
    return this.db.model('dictionaryItem').findMany({
      where: {
        dictId,
        searchCode: { contains: searchCode },
      },
      orderBy: { sortIndex: 'asc' },
    }) as Promise<DictionaryItem[]>;
  }

  async update(id: string, data: Partial<{
    name: string;
    value: string;
    text: string;
    sortIndex: number;
    description: string;
    status: boolean;
    properties: Record<string, unknown>;
    searchCode: string;
    valueType: string;
  }>): Promise<DictionaryItem> {
    const result = await this.db.model('dictionaryItem').update({
      where: { id },
      data,
    }) as DictionaryItem;
    this.emitCacheClear();
    return result;
  }

  async delete(id: string): Promise<void> {
    // Delete child nodes first — 使用 startsWith 精确匹配路径前缀，避免误删
    await this.db.model('dictionaryItem').deleteMany({
      where: {
        OR: [
          { path: { startsWith: `${id}/` } },
          { path: { startsWith: `/${id}/` } },
        ],
      },
    });
    await this.db.model('dictionaryItem').delete({ where: { id } });
    this.emitCacheClear();
  }

  /**
   * Move an item to a new parent and/or position.
   * Rebuilds path for the moved item and all descendants.
   */
  async move(
    id: string,
    targetParentId: string | null,
    sortIndex: number,
  ): Promise<void> {
    const newPath = targetParentId
      ? await this.buildPath(targetParentId)
      : '';

    await this.db.model('dictionaryItem').update({
      where: { id },
      data: {
        parentId: targetParentId,
        sortIndex,
        path: newPath,
      },
    });

    // Rebuild paths for descendants
    await this.rebuildDescendantPaths(id, newPath ? `${newPath}/${id}` : id);
  }

  /**
   * Get all items matching specific values within a dictionary.
   */
  async findByValues(dictId: string, values: string[]): Promise<DictionaryItem[]> {
    return this.db.model('dictionaryItem').findMany({
      where: {
        dictId,
        value: { in: values },
      },
    }) as Promise<DictionaryItem[]>;
  }

  /**
   * Get the next ordinal value for a dictionary.
   * Finds the current max ordinal and returns max + 1.
   */
  private async nextOrdinal(dictId: string): Promise<number> {
    const items = (await this.db.model('dictionaryItem').findMany({
      where: { dictId },
      orderBy: { ordinal: 'desc' },
      take: 1,
    })) as Array<{ ordinal: number }>;
    return (items[0]?.ordinal ?? -1) + 1;
  }

  private buildTree(items: DictionaryItem[]): TreeNode[] {
    const map = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];

    for (const item of items) {
      map.set(item.id, {
        id: item.id,
        name: item.name,
        value: item.value,
        text: item.text,
        parentId: item.parentId,
        sortIndex: item.sortIndex ?? 0,
        description: item.description,
        status: item.status,
        properties: item.properties,
        children: [],
      });
    }

    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortFn = (a: TreeNode, b: TreeNode) => a.sortIndex - b.sortIndex;
    roots.sort(sortFn);
    for (const node of map.values()) {
      node.children.sort(sortFn);
    }

    return roots;
  }

  private async buildPath(parentId: string): Promise<string> {
    const parent = await this.db.model('dictionaryItem').findUnique({
      where: { id: parentId },
    }) as DictionaryItem | null;
    if (!parent) return parentId;
    const parentPath = parent.path ? `${parent.path}/${parentId}` : parentId;
    return parentPath;
  }

  /**
   * Emit a cache clear event for dictionary caches.
   *
   * on every insert, update, delete, save operation.
   */
  private emitCacheClear(): void {
    if (this.eventEmitter) {
      this.eventEmitter.emit(
        'zucker.dictionary-cache-clear',
        ClearDictionaryCacheEvent.of(),
      );
    }
  }

  private async rebuildDescendantPaths(parentId: string, parentPath: string): Promise<void> {
    const children = await this.db.model('dictionaryItem').findMany({
      where: { parentId },
    }) as DictionaryItem[];

    for (const child of children) {
      const childPath = `${parentPath}/${child.id}`;
      await this.db.model('dictionaryItem').update({
        where: { id: child.id },
        data: { path: childPath },
      });
      await this.rebuildDescendantPaths(child.id, childPath);
    }
  }
}
