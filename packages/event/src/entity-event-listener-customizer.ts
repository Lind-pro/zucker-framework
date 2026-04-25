import { EntityEventListenerConfigure } from './entity-event-listener-configure';

/**
 * 实体事件监听器自定义接口 — 参考 hsweb EntityEventListenerCustomizer
 *
 * 实现此接口可在应用启动时对 EntityEventListenerConfigure 进行编程式配置。
 *
 * @example
 * ```ts
 * @Injectable()
 * class MyCustomizer implements EntityEventListenerCustomizer {
 *   customize(configure: EntityEventListenerConfigure): void {
 *     // 禁用 audit_log 实体的 QUERY 事件
 *     configure.disable('audit_log', EntityEventType.QUERY);
 *     // 仅禁用 user 实体的 DELETE.BEFORE 阶段
 *     configure.disable('user', EntityEventType.DELETE, EntityEventPhase.BEFORE);
 *   }
 * }
 * ```
 */
export interface EntityEventListenerCustomizer {
  customize(configure: EntityEventListenerConfigure): void;
}

export const ENTITY_EVENT_LISTENER_CUSTOMIZER = 'ENTITY_EVENT_LISTENER_CUSTOMIZER';
