import { EntityEventType } from './entity-events';

/**
 * 实体事件配置元数据 key
 */
export const ENTITY_EVENT_CONFIG_KEY = 'zucker:event:entityEventConfig';

/**
 * 实体事件配置
 */
export interface EntityEventConfig {
  [EntityEventType.CREATE]?: boolean;
  [EntityEventType.MODIFY]?: boolean;
  [EntityEventType.DELETE]?: boolean;
  [EntityEventType.SAVE]?: boolean;
  [EntityEventType.QUERY]?: boolean;
}

const DEFAULT_CONFIG: EntityEventConfig = {
  [EntityEventType.CREATE]: true,
  [EntityEventType.MODIFY]: true,
  [EntityEventType.DELETE]: true,
  [EntityEventType.SAVE]: true,
  [EntityEventType.QUERY]: false,
};

/**
 * @EnableEntityEvent() 装饰器
 *
 * 用于 Service 类，控制哪些实体事件需要发出。
 * 默认启用 create/modify/delete/save，禁用 query。
 *
 * @example
 * ```ts
 * @EnableEntityEvent({ query: true })
 * class UserService extends BaseService<User> { ... }
 *
 * @EnableEntityEvent({ delete: false })
 * class LogService extends BaseService<Log> { ... }
 * ```
 */
export function EnableEntityEvent(config?: Partial<EntityEventConfig>): ClassDecorator {
  return function (target: Function) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    Reflect.defineMetadata(ENTITY_EVENT_CONFIG_KEY, merged, target);
  };
}

/**
 * 获取实体事件配置
 * 如果没有装饰器，返回默认配置（全部启用除 query）
 */
export function getEntityEventConfig(target: Function): EntityEventConfig {
  return Reflect.getMetadata(ENTITY_EVENT_CONFIG_KEY, target) ?? DEFAULT_CONFIG;
}

/**
 * 检查指定事件类型是否启用
 */
export function isEntityEventEnabled(target: Function, type: EntityEventType): boolean {
  const config = getEntityEventConfig(target);
  return config[type] !== false;
}
