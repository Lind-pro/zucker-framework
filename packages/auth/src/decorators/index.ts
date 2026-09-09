import { SetMetadata, applyDecorators, createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
  AUTHORIZE_KEY,
  DATA_PERMISSION_KEY,
  TWO_FACTOR_KEY,
  DIMENSION_KEY,
} from './constants';

// ============================================================
// @Public() - 标记公开端点，跳过 JWT 和权限检查
// ============================================================

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

// ============================================================
// @Permissions(...permissions) - 字符串权限检查
// ============================================================

export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const RequirePermissions = Permissions;

// ============================================================
// @Resource / @Action - 资源-动作权限模型
// ============================================================

export interface ResourceOptions {
  id: string;
  name: string;
  description?: string;
  optionalFields?: Array<{ name: string; description: string }>;
}

export interface ActionOptions {
  action: string;
  name: string;
  description?: string;
}

export type AuthorizeLogical = 'AND' | 'OR' | 'DEFAULT';
export type AuthorizePhased = 'before' | 'after';

export interface AuthorizeResourceOptions extends ResourceOptions {
  actions?: ActionOptions[];
  merge?: boolean;
  logical?: AuthorizeLogical;
  phased?: AuthorizePhased;
  group?: string[];
}

export const Resource = (options: ResourceOptions) =>
  SetMetadata(RESOURCE_KEY, options);

export const Action = (options: ActionOptions) =>
  SetMetadata(ACTION_KEY, options);

export const QueryAction = (name = '查询', description = '查询数据') =>
  Action({ action: 'query', name, description });

/**
 * Create action.
 */
export const CreateAction = (name = '新增', description = '新增数据') =>
  Action({ action: 'add', name, description });

export const SaveAction = (name = '保存', description = '保存数据') =>
  Action({ action: 'save', name, description });

export const DeleteAction = (name = '删除', description = '删除数据') =>
  Action({ action: 'delete', name, description });

export const UpdateAction = (name = '更新', description = '更新数据') =>
  Action({ action: 'update', name, description });

export const ResourceAction = (options: ActionOptions) => Action(options);

// ============================================================
// @CurrentUser(field?) - 获取当前登录用户
// ============================================================

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return null;
    return data ? user[data] : user;
  },
);

// ============================================================
// @DataPermission(options) - 数据权限检查
// ============================================================

export interface DataPermissionOptions {
  dataType?: string;
  skipDataPermission?: boolean;
}

export const DataPermission = (
  options: DataPermissionOptions | string = {},
) => {
  const finalOptions: DataPermissionOptions =
    typeof options === 'string' ? { dataType: options } : options;
  return SetMetadata(DATA_PERMISSION_KEY, finalOptions);
};

export const SkipDataPermission = () =>
  SetMetadata(DATA_PERMISSION_KEY, { skipDataPermission: true });

// ============================================================
// @TwoFactor(options) - 双因素认证装饰器
// @TwoFactor 装饰器支持类和方法级别
// ============================================================

export interface TwoFactorOptions {
  /** 操作标识 — 用于区分不同操作的验证规则 */
  operation: string;
  /** 验证有效期（毫秒），默认 10 分钟 */
  timeout?: number;
  /** 验证器供应商（totp/sms/email），默认 'default' */
  provider?: string;
  /** 验证码的 HTTP 参数名，默认 'verifyCode' */
  parameter?: string;
  /** 是否忽略/关闭验证，默认 false */
  ignore?: boolean;
  /** 验证失败提示消息 */
  message?: string;
}

export interface ResolvedAuthorizeOptions {
  resources: AuthorizeResourceOptions[];
  dimensions: DimensionOptions[];
  permissions?: string[];
  dataPermission?: DataPermissionOptions;
  ignore: boolean;
  message: string;
  merge: boolean;
  logical: AuthorizeLogical;
  phased: AuthorizePhased;
  description: string[];
}

export const TwoFactor = (
  options: string | TwoFactorOptions,
): ClassDecorator & MethodDecorator => {
  const finalOptions: TwoFactorOptions =
    typeof options === 'string'
      ? { operation: options }
      : options;
  return SetMetadata(TWO_FACTOR_KEY, {
    timeout: 10 * 60 * 1000,
    provider: 'default',
    parameter: 'verifyCode',
    ignore: false,
    message: '验证码错误或已过期',
    ...finalOptions,
  });
};

// ============================================================
// @Authorize(options) - 组合权限装饰器
// @Authorize 支持 resources + dimension + ignore
// ============================================================

export interface AuthorizeOptions {
  /** 资源定义 — 用于资源-动作模型 */
  resource?: ResourceOptions;
  /** 动作定义 — 用于资源-动作模型 */
  action?: ActionOptions;
  /** 多资源定义 */
  resources?: AuthorizeResourceOptions[];
  /** 维度定义 */
  dimension?: DimensionOptions[];
  /** 字符串权限列表 — 简单模式 */
  permissions?: string[];
  /** 数据权限选项 */
  dataPermission?: DataPermissionOptions;
  /** 是否忽略（等同 @Public） */
  ignore?: boolean;
  /** 验证失败消息 */
  message?: string;
  /** 是否合并类上的注解 */
  merge?: boolean;
  /** 多个资源/维度时的判断逻辑 */
  logical?: AuthorizeLogical;
  /** 验证时机 */
  phased?: AuthorizePhased;
  /** 说明文本 */
  description?: string[];
}

/**
 * @Authorize 组合装饰器
 *
 * 将 @Resource, @Action, @Permissions, @DataPermission, @Public
 * 组合为单个装饰器，简化常用权限声明。
 *
 * 支持类级别和方法级别。
 *
 * @example
 * ```ts
 * @Authorize({ resource: { id: 'user', name: '用户' }, action: { action: 'query', name: '查询' } })
 * async list() { ... }
 *
 * @Authorize({ ignore: true })
 * async publicEndpoint() { ... }
 *
 * @Authorize({ permissions: ['admin:manage'] })
 * async adminOnly() { ... }
 * ```
 */
export function Authorize(options: AuthorizeOptions): ClassDecorator & MethodDecorator {
  const decorators: Array<ClassDecorator | MethodDecorator> = [];
  const normalized = normalizeAuthorizeOptions(options);

  decorators.push(SetMetadata(AUTHORIZE_KEY, normalized));

  if (normalized.ignore) {
    decorators.push(SetMetadata(IS_PUBLIC_KEY, true));
  }
  if (normalized.resources.length === 1) {
    const [resource] = normalized.resources;
    decorators.push(SetMetadata(RESOURCE_KEY, stripResourceActions(resource)));
    if ((resource.actions?.length ?? 0) === 1) {
      decorators.push(SetMetadata(ACTION_KEY, resource.actions![0]));
    }
  }
  if (normalized.permissions !== undefined) {
    decorators.push(SetMetadata(PERMISSIONS_KEY, normalized.permissions));
  }
  if (normalized.dimensions.length === 1) {
    decorators.push(SetMetadata(DIMENSION_KEY, normalized.dimensions[0]));
  }
  if (normalized.dataPermission) {
    decorators.push(SetMetadata(DATA_PERMISSION_KEY, normalized.dataPermission));
  }

  return applyDecorators(...decorators) as ClassDecorator & MethodDecorator;
}

// ============================================================
// @RequiresRoles(...roles) - 角色维度检查
// @RequiresRoles 使用 role 维度校验角色
// ============================================================

export interface DimensionOptions {
  type: string;
  ids: string[];
  logical?: AuthorizeLogical;
}

/**
 * @DimensionCheck 装饰器
 *
 * 通用维度权限检查，支持角色、部门等维度类型。
 */
export const DimensionCheck = (options: DimensionOptions): ClassDecorator & MethodDecorator =>
  SetMetadata(DIMENSION_KEY, options);

/**
 * @RequiresRoles 装饰器
 *
 * 要求用户拥有指定角色之一（OR 逻辑）。
 */
export interface RequiresRolesOptions {
  logical?: AuthorizeLogical;
}

export function RequiresRoles(...roles: string[]): ClassDecorator & MethodDecorator;
export function RequiresRoles(
  options: RequiresRolesOptions,
  ...roles: string[]
): ClassDecorator & MethodDecorator;
export function RequiresRoles(
  ...args: [RequiresRolesOptions, ...string[]] | string[]
): ClassDecorator & MethodDecorator {
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    return DimensionCheck({ type: 'role', ids: args as string[], logical: 'DEFAULT' });
  }
  return DimensionCheck({
    type: 'role',
    ids: rest as string[],
    logical: first.logical ?? 'DEFAULT',
  });
}

function normalizeAuthorizeOptions(options: AuthorizeOptions): ResolvedAuthorizeOptions {
  const resources = [
    ...(options.resources ?? []).map((resource) => cloneAuthorizeResource(resource)),
    ...(options.resource
      ? [{
          ...cloneResource(options.resource),
          actions: options.action ? [cloneAction(options.action)] : [],
        }]
      : []),
  ];

  return {
    resources,
    dimensions: (options.dimension ?? []).map((dimension) => ({
      type: dimension.type,
      ids: [...dimension.ids],
      logical: dimension.logical ?? 'DEFAULT',
    })),
    permissions: options.permissions ? [...options.permissions] : options.permissions,
    dataPermission: options.dataPermission ? { ...options.dataPermission } : undefined,
    ignore: options.ignore ?? false,
    message: options.message ?? '无访问权限',
    merge: options.merge ?? true,
    logical: options.logical ?? 'DEFAULT',
    phased: options.phased ?? 'before',
    description: options.description ? [...options.description] : [],
  };
}

function cloneAuthorizeResource(resource: AuthorizeResourceOptions): AuthorizeResourceOptions {
  return {
    ...cloneResource(resource),
    actions: resource.actions?.map((action) => cloneAction(action)),
    merge: resource.merge,
    logical: resource.logical ?? 'DEFAULT',
    phased: resource.phased ?? 'before',
    group: resource.group ? [...resource.group] : undefined,
  };
}

function cloneResource(resource: ResourceOptions): ResourceOptions {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    optionalFields: resource.optionalFields?.map((field) => ({ ...field })),
  };
}

function cloneAction(action: ActionOptions): ActionOptions {
  return {
    action: action.action,
    name: action.name,
    description: action.description,
  };
}

function stripResourceActions(resource: AuthorizeResourceOptions): ResourceOptions {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    optionalFields: resource.optionalFields?.map((field) => ({ ...field })),
  };
}

// Re-export constants
export {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
  AUTHORIZE_KEY,
  DATA_PERMISSION_KEY,
  TWO_FACTOR_KEY,
  DIMENSION_KEY,
} from './constants';
