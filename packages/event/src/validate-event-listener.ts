import { validate, type ValidationError } from 'class-validator';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { EntityEvent, EntityEventPhase, EntityEventType } from './entity-events';
import { EntityEventListener } from './entity-event-listener';

/**
 * 验证分组 — 参考 hsweb CreateGroup / UpdateGroup
 *
 * 使用 class-validator 的 groups 功能区分创建和更新时的不同校验规则。
 *
 * @example
 * ```ts
 * class User {
 *   @IsNotEmpty({ groups: [CREATE_GROUP] })
 *   name: string;
 *
 *   @IsEmail({}, { groups: [CREATE_GROUP, UPDATE_GROUP] })
 *   email: string;
 * }
 * ```
 */
export const CREATE_GROUP = 'create';
export const UPDATE_GROUP = 'update';
export const SAVE_GROUP = 'save';

/**
 * PREPARE 阶段的自动校验监听器
 *
 * 在 PREPARE 阶段使用 class-validator 校验实体数据。
 * 校验失败时，取消操作（event.cancel）。
 *
 * 与 hsweb ValidateEventListener 一致：
 * - CREATE/SAVE 操作使用 CreateGroup
 * - UPDATE/MODIFY 操作使用 UpdateGroup
 * - 用户可通过 options.groups 覆盖默认分组
 *
 * 用法：
 *   new ValidateEventListener(UserEntity)
 *   注册到 entity.user.create.prepare 和 entity.user.update.prepare
 */
export class ValidateEventListener<T extends object> implements EntityEventListener<T> {
  constructor(
    private readonly entityClass: ClassConstructor<T>,
    private readonly options?: {
      /** 跳过校验的事件类型 */
      skipTypes?: EntityEventType[];
      /** class-validator 的 groups（覆盖默认分组策略） */
      groups?: string[];
      /** 是否跳过缺失属性（适用于 partial update） */
      skipMissingProperties?: boolean;
    },
  ) {}

  async onEvent(event: EntityEvent<T>): Promise<void> {
    if (event.phase !== EntityEventPhase.PREPARE) return;
    if (this.options?.skipTypes?.includes(event.type)) return;

    // 根据事件类型自动选择验证分组 — 参考 hsweb 的 CreateGroup/UpdateGroup
    const groups = this.options?.groups ?? this.resolveGroups(event.type);

    // update/modify 时默认跳过缺失属性
    const skipMissing = this.options?.skipMissingProperties ??
      ((event.type as string) === EntityEventType.MODIFY);

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;

      const instance = plainToInstance(this.entityClass, entity);
      const errors = await validate(instance, {
        skipMissingProperties: skipMissing,
        groups: groups.length > 0 ? groups : undefined,
        whitelist: false,
        forbidNonWhitelisted: false,
      });

      if (errors.length > 0) {
        const message = formatValidationErrors(errors);
        // 取消操作 — 会在 BEFORE 阶段生效
        event.cancel(`Validation failed: ${message}`);
        return;
      }
    }
  }

  /**
   * 根据事件类型解析默认的校验分组
   */
  private resolveGroups(type: EntityEventType): string[] {
    switch (type) {
      case EntityEventType.CREATE:
        return [CREATE_GROUP];
      case EntityEventType.SAVE:
        return [CREATE_GROUP, SAVE_GROUP];
      case EntityEventType.MODIFY:
        return [UPDATE_GROUP];
      default:
        return [];
    }
  }
}

function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => {
      const constraints = e.constraints ? Object.values(e.constraints).join(', ') : 'invalid';
      return `${e.property}: ${constraints}`;
    })
    .join('; ');
}
