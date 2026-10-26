import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter } from '@zucker-framework/core';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
import type { DictionaryItem } from './index';
import type { DictDefine } from './dict-define';
import { ClearDictionaryCacheEvent } from './clear-dictionary-cache-event';

/** Internal model for dictionary row (without items relation) */
interface DictionaryRow {
  id: string;
  code?: string;
  name: string;
  classified: string;
  describe: string;
  status?: boolean;
}

/**
 * Dictionary with populated items
 * with items field populated.
 */
export interface DictionaryDetail extends DictionaryRow {
  items: DictionaryItem[];
}

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

export const DICT_CHANGED_EVENT = 'zucker.dictionary-changed';

/**
 * TopicEventBus topic for dictionary changes.
 * Uses `/` delimiter to match DefaultTopicEventBus conventions.
 * Subscribers can use wildcards: `system/dictionary/**`
 */
export const DICT_CHANGED_TOPIC = 'system/dictionary/changed';

export interface DictChangePayload {
  type: 'created' | 'updated' | 'deleted';
  dictId: string;
}

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker-framework/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

@Injectable()
export class DictionaryService {
  private readonly logger = new Logger(DictionaryService.name);
  private readonly cache = new Map<string, DictionaryRow>();

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

  /**
   * 查询所有字典
   * @returns 字典列表
   */
  async findAll(): Promise<DictionaryRow[]> {
    return this.db.model('dictionary').findMany() as Promise<DictionaryRow[]>;
  }

  /**
   * 根据 ID 查询字典（不存在时返回 null）
   * @param id 字典 ID
   * @returns 字典记录或 null
   */
  async findById(id: string): Promise<DictionaryRow | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;

    const dict = await this.db.model('dictionary').findUnique({
      where: { id },
    }) as DictionaryRow | null;
    if (dict) this.cache.set(id, dict);
    return dict;
  }

  /**
   * 按分类查询字典列表
   * @param classified 分类名称
   * @returns 该分类下的字典列表
   */
  async findByClassified(classified: string): Promise<DictionaryRow[]> {
    return this.db.model('dictionary').findMany({
      where: { classified },
    }) as Promise<DictionaryRow[]>;
  }

  /**
   * 创建字典
   * @param data 字典数据
   * @returns 创建后的字典记录
   */
  async create(data: { name: string; classified: string; describe?: string }): Promise<DictionaryRow> {
    const dict = await this.db.model('dictionary').create({ data }) as DictionaryRow;
    this.clearCache();
    await this.emitChange('created', dict.id);
    return dict;
  }

  /**
   * 更新字典
   * @param id 字典 ID
   * @param data 要更新的字段
   * @returns 更新后的字典记录
   */
  async update(id: string, data: Partial<{ name: string; classified: string; describe: string }>): Promise<DictionaryRow> {
    const dict = await this.db.model('dictionary').update({
      where: { id },
      data,
    }) as DictionaryRow;
    this.clearCache();
    await this.emitChange('updated', id);
    return dict;
  }

  /**
   * 删除字典
   * @param id 字典 ID
   */
  async delete(id: string): Promise<void> {
    await this.db.model('dictionary').delete({ where: { id } });
    this.clearCache();
    await this.emitChange('deleted', id);
  }

  /**
   * Find a dictionary by ID with its items populated, sorted by ordinal.
   *
   * @param id Dictionary ID
   * @returns Dictionary with items, or null if not found
   */
  async findDetailById(id: string): Promise<DictionaryDetail | null> {
    const dict = await this.findById(id);
    if (!dict) return null;

    const items = (await this.db.model('dictionaryItem').findMany({
      where: { dictId: id },
      orderBy: { ordinal: 'asc' },
    })) as DictionaryItem[];

    return { ...dict, items };
  }

  /**
   * Find all dictionaries with their items populated.
   * Optionally filter out dictionaries with no items.
   *
   * @param options.allowEmptyItems If false (default), exclude dicts with no items
   * @param options.classified Optional classified filter
   */
  async findAllDetail(options?: {
    allowEmptyItems?: boolean;
    classified?: string;
  }): Promise<DictionaryDetail[]> {
    const where: Record<string, unknown> = {};
    if (options?.classified) {
      where.classified = options.classified;
    }

    const dicts = (await this.db.model('dictionary').findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
    })) as DictionaryRow[];

    if (dicts.length === 0) return [];

    const dictIds = dicts.map((d) => d.id);
    const allItems = (await this.db.model('dictionaryItem').findMany({
      where: { dictId: { in: dictIds } },
      orderBy: { ordinal: 'asc' },
    })) as DictionaryItem[];

    // Group items by dictId
    const itemsByDictId = new Map<string, DictionaryItem[]>();
    for (const item of allItems) {
      const list = itemsByDictId.get(item.dictId) ?? [];
      list.push(item);
      itemsByDictId.set(item.dictId, list);
    }

    const results: DictionaryDetail[] = [];
    for (const dict of dicts) {
      const items = itemsByDictId.get(dict.id) ?? [];
      if (!options?.allowEmptyItems && items.length === 0) {
        continue;
      }
      results.push({ ...dict, items });
    }

    return results;
  }

  /**
   * Convert a DictionaryDetail to a DictDefine.
   *
   * — builds DefaultDictDefine from entity id, name (as alias), describe (as comments), items
   *
   * @param detail - Dictionary with populated items
   * @returns A DictDefine compatible with DictDefineRepository
   */
  toDictDefine(detail: DictionaryDetail): DictDefine {
    return {
      id: detail.id,
      alias: detail.name,
      comments: detail.describe,
      items: (detail.items ?? []).map((item, index) => ({
        value: item.value,
        text: item.text,
        ordinal: item.ordinal ?? index,
        comments: item.description,
      })),
    };
  }

  clearCache(dictId?: string): void {
    if (dictId) {
      this.cache.delete(dictId);
    } else {
      this.cache.clear();
    }
  }

  onChange(callback: (payload: DictChangePayload) => void): { unsubscribe: () => void } {
    if (!this.eventEmitter) {
      return { unsubscribe: () => {} };
    }
    this.eventEmitter.on(DICT_CHANGED_EVENT, callback);
    return {
      unsubscribe: () => this.eventEmitter!.off(DICT_CHANGED_EVENT, callback),
    };
  }

  /**
   * Create a ClearDictionaryCacheEvent for the given dictionary ID.
   */
  createClearCacheEvent(dictId?: string): ClearDictionaryCacheEvent {
    return ClearDictionaryCacheEvent.of(dictId);
  }

  /**
   * 导出字典数据（包含字典和字典项）
   */
  async exportDictionaries(dictIds?: string[]): Promise<Array<{ dictionary: unknown; items: unknown[] }>> {
    const where = dictIds?.length ? { id: { in: dictIds } } : {};
    const dictionaries = await this.db.model('dictionary').findMany({ where });

    const result: Array<{ dictionary: unknown; items: unknown[] }> = [];
    for (const dict of dictionaries as Array<{ id: string }>) {
      const items = await this.db.model('dictionaryItem').findMany({
        where: { dictId: dict.id },
        orderBy: { ordinal: 'asc' },
      });
      result.push({ dictionary: dict, items: items as unknown[] });
    }
    return result;
  }

  /**
   * 导入字典数据（含冲突处理：已存在则更新，不存在则创建）
   */
  async importDictionaries(
    data: Array<{ dictionary: Record<string, unknown>; items: Array<Record<string, unknown>> }>,
  ): Promise<{ imported: number; updated: number; failed: number }> {
    let imported = 0;
    let updated = 0;
    let failed = 0;

    for (const entry of data) {
      try {
        const dictId = entry.dictionary.id as string;

        await this.db.$transaction(async (tx) => {
          const existing = await tx.model('dictionary').findUnique({ where: { id: dictId } });

          if (existing) {
            await tx.model('dictionary').update({
              where: { id: dictId },
              data: entry.dictionary,
            });
            updated++;
          } else {
            await tx.model('dictionary').create({ data: entry.dictionary });
            imported++;
          }

          // 同步字典项：先删除旧的，再批量创建
          await tx.model('dictionaryItem').deleteMany({ where: { dictId } });
          for (const item of entry.items) {
            await tx.model('dictionaryItem').create({
              data: { ...item, dictId },
            });
          }
        });
      } catch (error) {
        this.logger.error(`Dictionary import failed: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }

    return { imported, updated, failed };
  }

  /**
   * 搜索字典项（按名称或值模糊匹配）
   */
  async searchItems(
    keyword: string,
    options?: { dictId?: string; limit?: number },
  ): Promise<unknown[]> {
    const where: Record<string, unknown> = {
      OR: [
        { text: { contains: keyword, mode: 'insensitive' } },
        { value: { contains: keyword, mode: 'insensitive' } },
      ],
    };
    if (options?.dictId) {
      where.dictId = options.dictId;
    }

    return this.db.model('dictionaryItem').findMany({
      where,
      take: options?.limit ?? 50,
      orderBy: { ordinal: 'asc' },
    });
  }

  private async emitChange(type: DictChangePayload['type'], dictId: string): Promise<void> {
    const payload: DictChangePayload = { type, dictId };
    if (this.eventEmitter) {
      this.eventEmitter.emit(DICT_CHANGED_EVENT, payload);
      // Also emit typed cache clear event for CompositeDictDefineRepository integration
      this.eventEmitter.emit(
        'zucker.dictionary-cache-clear',
        ClearDictionaryCacheEvent.of(dictId),
      );
    }
    // Publish to TopicEventBus for cross-module event-driven integration
    if (this.topicEventBus) {
      await this.topicEventBus.publish(DICT_CHANGED_TOPIC, payload);
    }
  }
}
