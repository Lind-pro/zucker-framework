export enum EntityEventType {
  CREATE = 'create',
  /** modify */
  MODIFY = 'modify',
  DELETE = 'delete',
  /** save */
  SAVE = 'save',
  QUERY = 'query',

  /**
   * @deprecated 请使用 MODIFY
   */
  UPDATE = 'modify',
}

export enum EntityEventPhase {
  /**
   * PREPARE 阶段 — 实体数据预处理
   *
   * 契约：监听器可以修改 event.entity 上的字段值，
   * 修改后的数据会流入后续的数据库操作。
   * 典型用途：自动填充 creatorId/createdAt、数据清洗、默认值设置。
   */
  PREPARE = 'prepare',

  /**
   * BEFORE 阶段 — 操作前校验与拦截
   *
   * 契约：监听器可以调用 event.cancel() 取消操作，
   * BaseService 将在此阶段后检查 cancelled 标志并抛出 OperationCancelledException。
   * 典型用途：业务规则校验、权限检查、并发控制。
   */
  BEFORE = 'before',

  /**
   * AFTER 阶段 — 操作完成后的后续处理
   *
   * 契约：数据已持久化，此阶段用于触发副作用。
   * 在事务内时，建议使用 TransactionUtils.afterCommit() 确保 commit 后才执行。
   */
  AFTER = 'after',
}

/**
 * 所有事件阶段
 *
 * 便捷常量，包含 PREPARE、BEFORE 和 AFTER 三个阶段。
 */
export const ALL_EVENT_PHASES: readonly EntityEventPhase[] = [
  EntityEventPhase.PREPARE,
  EntityEventPhase.BEFORE,
  EntityEventPhase.AFTER,
];

export interface EntityEvent<T = unknown> {
  type: EntityEventType;
  phase: EntityEventPhase;
  entityType: string;
  entity: T | T[];
  timestamp: number;

  /**
   * 修改前的实体数据
   *
   * 仅在 MODIFY 类型事件中有值。
   * before 保存旧数据，entity 保存新数据；二者均支持单条实体或实体列表。
   */
  readonly before?: T | T[];

  /** 事件是否已被取消（仅 BEFORE 阶段有效） */
  readonly cancelled: boolean;

  /**
   * 取消操作（仅 BEFORE 阶段有意义）
   * 调用后 BaseService 将抛出 OperationCancelledException
   * @param reason 取消原因，会包含在异常消息中
   */
  cancel(reason?: string): void;

  /** 取消原因 */
  readonly cancelReason?: string;
}

/**
 * Create a new EntityEvent instance with cancel support.
 * @param type - The event type (CREATE, MODIFY, DELETE, etc.)
 * @param phase - The event phase (PREPARE, BEFORE, AFTER)
 * @param entityType - The entity/model name
 * @param entity - The entity data (single or batch). For MODIFY events this is the "after" data.
 * @param before - Optional "before" data for MODIFY events
 * @returns A new EntityEvent with cancel() capability
 */
export function createEntityEvent<T>(
  type: EntityEventType,
  phase: EntityEventPhase,
  entityType: string,
  entity: T | T[],
  before?: T | T[],
): EntityEvent<T> {
  let _cancelled = false;
  let _cancelReason: string | undefined;

  return {
    type,
    phase,
    entityType,
    entity,
    timestamp: Date.now(),
    before,

    get cancelled() {
      return _cancelled;
    },

    cancel(reason?: string) {
      _cancelled = true;
      _cancelReason = reason;
    },

    get cancelReason() {
      return _cancelReason;
    },
  };
}

/**
 * 生成事件名: entity/{entityType}/{type}/{phase}
 * 例如: entity/user/create/before
 *
 * 使用 `/` 分隔符以匹配 DefaultTopicEventBus 的 delimiter 配置，
 * 使通配符订阅（如 `entity/* /create/*`）能正确匹配事件名。
 */
export function getEntityEventName(
  entityType: string,
  type: EntityEventType,
  phase: EntityEventPhase,
): string {
  return `entity/${entityType}/${type}/${phase}`;
}

/**
 * Non-enumerable marker set by `CrudService.save` / `saveOrUpdate` on each SAVE entity after its
 * existence probe: `true` = will be created, `false` = will update an existing row. Listeners use
 * it to fill creator fields for new rows that carry a client-generated id. Absent marker: fall
 * back to "has an id → update".
 */
export const ENTITY_IS_NEW = Symbol.for('zucker.entity.isNew');

/** Mark a SAVE entity as new (create) or existing (update). The marker is not enumerable. */
export function markEntityIsNew(entity: object, isNew: boolean): void {
  Object.defineProperty(entity, ENTITY_IS_NEW, { value: isNew, enumerable: false, configurable: true, writable: true });
}

/** Whether a SAVE entity creates a row: the marker when present, otherwise `!entity.id`. */
export function isNewSaveEntity(entity: Record<string, unknown>): boolean {
  const marker = (entity as Record<symbol, unknown>)[ENTITY_IS_NEW];
  return typeof marker === 'boolean' ? marker : !entity.id;
}
