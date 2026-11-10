import { Get, Post, Put, Delete, Body, Param, SetMetadata } from '@nestjs/common';
import { sanitizeWriteBody, type CrudWritePolicy } from './write-policy';

/**
 * CRUD 自动生成装饰器 — 对标 Claude Code Tool 统一注册模式
 *
 * 将重复的 CRUD Controller 代码抽象为声明式配置。
 * 生成标准端点: POST /_query, GET /:id, POST /, PUT /:id, DELETE /:id
 *
 * 注意: 这是元数据标记 + mixin 模式，需配合 CrudControllerFactory 使用。
 *
 * 用法:
 * ```ts
 * @Controller('admin/users')
 * class UsersController extends CrudControllerFactory(UserService, {
 *   routes: {
 *     query: { decorators: [Permissions('user:query')] },
 *     create: { decorators: [Permissions('user:add')] },
 *   },
 * }) {
 *   // 自动拥有 query/findOne/create/update/delete 方法
 *   // 只需手写非标准端点
 * }
 * ```
 */

export const CRUD_METADATA = Symbol('CRUD_METADATA');

export interface CrudRouteConfig {
  /** 额外的装饰器（如权限控制） */
  decorators?: MethodDecorator[];
  /** 是否启用此路由（默认 true） */
  enabled?: boolean;
}

export interface CrudOptions {
  routes?: {
    query?: CrudRouteConfig;
    findOne?: CrudRouteConfig;
    create?: CrudRouteConfig;
    update?: CrudRouteConfig;
    delete?: CrudRouteConfig;
  };
  /** 软删除模式（delete 时调用 softDelete 而非 delete） */
  softDelete?: boolean;
  /** Body policy for create / update (see BaseControllerOptions.writePolicy). */
  writePolicy?: CrudWritePolicy;
}

/**
 * CRUD Controller 工厂
 *
 * 生成一个带标准 CRUD 方法的基类，子类可以覆写或扩展。
 */
export function CrudControllerFactory<T>(
  serviceToken: new (...args: unknown[]) => T,
  options: CrudOptions = {},
): new (...args: unknown[]) => object {
  const routes = options.routes ?? {};

  class CrudController {
    protected readonly service: any;
    [key: string]: any;

    constructor(service: any) {
      this.service = service;
    }
  }

  const proto = CrudController.prototype as Record<string, unknown>;
  type RouteName = keyof NonNullable<CrudOptions['routes']>;
  const define = (
    route: RouteName,
    method: string,
    handler: (this: CrudController, ...args: any[]) => Promise<unknown>,
    verb: MethodDecorator,
    params: Array<(target: object, key: string, index: number) => void>,
  ) => {
    if (routes[route]?.enabled === false) return;
    proto[method] = handler;
    // Parameter metadata must exist or Nest calls the handler without arguments.
    params.forEach((param, index) => param(proto, method, index));
    const descriptor = () => Object.getOwnPropertyDescriptor(proto, method)!;
    verb(proto, method, descriptor());
    for (const decorator of routes[route]?.decorators ?? []) decorator(proto, method, descriptor());
  };

  define('query', 'query', async function (body: any) {
    return this.service.findAll(body);
  }, Post('_query'), [Body()]);

  define('findOne', 'findOne', async function (id: string) {
    return this.service.findOne(id);
  }, Get(':id'), [Param('id')]);

  define('create', 'create', async function (body: any) {
    return this.service.create(sanitizeWriteBody(body, options.writePolicy, 'create'));
  }, Post(), [Body()]);

  define('update', 'update', async function (id: string, body: any) {
    return this.service.update(id, sanitizeWriteBody(body, options.writePolicy, 'update'));
  }, Put(':id'), [Param('id'), Body()]);

  define('delete', 'remove', async function (id: string) {
    if (options.softDelete) {
      return this.service.softDelete(id);
    }
    return this.service.delete(id);
  }, Delete(':id'), [Param('id')]);

  SetMetadata(CRUD_METADATA, options)(CrudController);

  return CrudController as any;
}
