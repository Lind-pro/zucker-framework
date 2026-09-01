import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface RelatedObject {
  sourceType: string;
  sourceId: string;
  /** Composite key derived from sourceType + sourceId. Mirrors Java RelatedEntity.objectKey. */
  sourceKey?: string;
  relation: string;
  targetType: string;
  targetId: string;
  /** Composite key derived from targetType + targetId. Mirrors Java RelatedEntity.relatedKey. */
  targetKey?: string;
  targetName?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Generate a composite key from type + id segments.
 * Mirrors Java RelatedEntity.generateKey() which uses MD5.
 */
export function generateRelationKey(...segments: string[]): string {
  return createHash('md5').update(segments.join('|')).digest('hex');
}

/**
 * 关系持久化存储接口
 */
export interface RelationStore {
  save(relation: RelatedObject): Promise<void>;
  remove(sourceType: string, sourceId: string, relation: string, targetType: string, targetId: string): Promise<void>;
  findRelated(sourceType: string, sourceId: string, relation?: string): Promise<RelatedObject[]>;
  /**
   * Find objects that relate TO the given target (reverse lookup).
   * Mirrors Java DefaultRelationObject.relations(reverse=true).
   */
  findReverseRelated(targetType: string, targetId: string, relation?: string): Promise<RelatedObject[]>;
  removeAll(sourceType: string, sourceId: string): Promise<void>;
  /**
   * Remove relations by relation type and target.
   * Mirrors Java RelationService.saveRelated() which deletes by objectKey + relatedType + relation.
   */
  removeByRelation?(sourceType: string, sourceId: string, relation: string, targetType: string): Promise<void>;
}

/**
 * 内存关系存储（默认实现）
 */
export class InMemoryRelationStore implements RelationStore {
  private relations: RelatedObject[] = [];

  async save(relation: RelatedObject): Promise<void> {
    // Populate composite keys
    if (!relation.sourceKey) {
      relation.sourceKey = generateRelationKey(relation.sourceType, relation.sourceId);
    }
    if (!relation.targetKey) {
      relation.targetKey = generateRelationKey(relation.targetType, relation.targetId);
    }

    // 去重
    const existing = this.relations.findIndex(
      (r) =>
        r.sourceType === relation.sourceType &&
        r.sourceId === relation.sourceId &&
        r.relation === relation.relation &&
        r.targetType === relation.targetType &&
        r.targetId === relation.targetId,
    );
    if (existing >= 0) {
      this.relations[existing] = relation;
    } else {
      this.relations.push(relation);
    }
  }

  async remove(
    sourceType: string,
    sourceId: string,
    relation: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    this.relations = this.relations.filter(
      (r) =>
        !(
          r.sourceType === sourceType &&
          r.sourceId === sourceId &&
          r.relation === relation &&
          r.targetType === targetType &&
          r.targetId === targetId
        ),
    );
  }

  async findRelated(sourceType: string, sourceId: string, relation?: string): Promise<RelatedObject[]> {
    return this.relations.filter(
      (r) =>
        r.sourceType === sourceType &&
        r.sourceId === sourceId &&
        (!relation || r.relation === relation),
    );
  }

  /**
   * Reverse lookup — find all objects that point TO the given target.
   * Mirrors Java DefaultRelationOperation with reverse=true.
   */
  async findReverseRelated(targetType: string, targetId: string, relation?: string): Promise<RelatedObject[]> {
    return this.relations.filter(
      (r) =>
        r.targetType === targetType &&
        r.targetId === targetId &&
        (!relation || r.relation === relation),
    );
  }

  async removeAll(sourceType: string, sourceId: string): Promise<void> {
    this.relations = this.relations.filter(
      (r) => !(r.sourceType === sourceType && r.sourceId === sourceId),
    );
  }

  async removeByRelation(sourceType: string, sourceId: string, relation: string, targetType: string): Promise<void> {
    this.relations = this.relations.filter(
      (r) =>
        !(
          r.sourceType === sourceType &&
          r.sourceId === sourceId &&
          r.relation === relation &&
          r.targetType === targetType
        ),
    );
  }
}

/**
 * 关系服务 — CRUD 操作
 * Mirrors Java RelationService with forward and reverse relation support.
 */
@Injectable()
export class RelationService {
  private readonly logger = new Logger(RelationService.name);

  constructor(private readonly store: RelationStore) {}

  /**
   * 绑定关系
   */
  async bind(
    sourceType: string,
    sourceId: string,
    relation: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>,
    targetName?: string,
  ): Promise<void> {
    await this.store.save({
      sourceType,
      sourceId,
      sourceKey: generateRelationKey(sourceType, sourceId),
      relation,
      targetType,
      targetId,
      targetKey: generateRelationKey(targetType, targetId),
      targetName,
      metadata,
      createdAt: new Date(),
    });
    this.logger.debug(`Relation bound: ${sourceType}:${sourceId} -[${relation}]-> ${targetType}:${targetId}`);
  }

  /**
   * 获取相关对象（正向查询）
   */
  async getRelated(
    sourceType: string,
    sourceId: string,
    relation?: string,
  ): Promise<RelatedObject[]> {
    return this.store.findRelated(sourceType, sourceId, relation);
  }

  /**
   * 获取反向相关对象 — 谁指向了我？
   * Mirrors Java RelationObject.relations(reverse=true).
   */
  async getReverseRelated(
    targetType: string,
    targetId: string,
    relation?: string,
  ): Promise<RelatedObject[]> {
    return this.store.findReverseRelated(targetType, targetId, relation);
  }

  /**
   * 解绑关系
   */
  async unbind(
    sourceType: string,
    sourceId: string,
    relation: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    await this.store.remove(sourceType, sourceId, relation, targetType, targetId);
    this.logger.debug(`Relation unbound: ${sourceType}:${sourceId} -[${relation}]-> ${targetType}:${targetId}`);
  }

  /**
   * 移除源对象的所有关系
   */
  async unbindAll(sourceType: string, sourceId: string): Promise<void> {
    await this.store.removeAll(sourceType, sourceId);
  }

  /**
   * 批量保存关系 — 替换指定 source + relation + targetType 下的所有关系。
   * Mirrors Java RelationService.saveRelated().
   */
  async saveRelated(
    sourceType: string,
    sourceId: string,
    relation: string,
    targetType: string,
    targets: Array<{ id: string; name?: string }>,
  ): Promise<void> {
    // Remove existing relations for this combination
    if (this.store.removeByRelation) {
      await this.store.removeByRelation(sourceType, sourceId, relation, targetType);
    }

    // Save new relations
    for (const target of targets) {
      await this.bind(sourceType, sourceId, relation, targetType, target.id, undefined, target.name);
    }
  }
}
