/**
 * Base entity interface with common audit fields.
 * All persistent entities should extend this interface.
 */
export interface GenericEntity {
  /** Unique identifier */
  id: string;
  /** Record creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * 记录创建信息的实体接口
 */
export interface RecordCreationEntity extends GenericEntity {
  creatorId?: string;
  creatorName?: string;
}

/**
 * 记录修改信息的实体接口
 * 与 RecordCreationEntity 分离
 */
export interface RecordModifierEntity extends GenericEntity {
  modifierId?: string;
  modifierName?: string;
}

/**
 * 同时记录创建者和修改者信息的实体接口
 */
export interface RecordCreationModifierEntity extends RecordCreationEntity, RecordModifierEntity {}

/**
 * 支持排序的实体接口
 */
export interface SortSupportEntity extends GenericEntity {
  sortIndex?: number;
}

/**
 * 支持树结构的实体接口
 */
export interface TreeSupportEntity extends GenericEntity {
  parentId?: string | null;
  path?: string;
  level?: number;
  children?: TreeSupportEntity[];
}

/**
 * 同时支持树结构和排序的实体接口
 */
export interface TreeSortSupportEntity extends RecordCreationModifierEntity, SortSupportEntity, TreeSupportEntity {
  children?: TreeSortSupportEntity[];
}

// ===================== 实体工具函数 =====================

/**
 * 设置创建时间为当前时间
 */
export function setCreateTimeNow<T extends RecordCreationEntity>(entity: T): T {
  entity.createdAt = new Date();
  return entity;
}

/**
 * 设置修改时间为当前时间
 */
export function setModifyTimeNow<T extends RecordModifierEntity>(entity: T): T {
  entity.updatedAt = new Date();
  return entity;
}

/**
 * 校验树节点的 parentId 不能等于自身 id
 * 检查 parentId != id，避免节点将自身作为父节点
 *
 * @throws Error 当 parentId 等于 id 时
 */
export function validateTreeEntity(entity: TreeSupportEntity): void {
  if (entity.id && entity.parentId && entity.id === entity.parentId) {
    throw new Error('子节点ID不能与父节点ID相同');
  }
}

/**
 * 比较排序值，用于排序支持实体
 */
export function compareSortIndex(a: SortSupportEntity, b: SortSupportEntity): number {
  return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
}
