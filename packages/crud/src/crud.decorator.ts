import { applyDecorators, Get, Post, Put, Delete, Body, Param, Query, SetMetadata } from '@nestjs/common';

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

  // 动态定义方法
  if (routes.query?.enabled !== false) {
    CrudController.prototype.query = async function (body: any) {
      return this.service.findAll(body);
    };
    Post('_query')(CrudController, 'query', Object.getOwnPropertyDescriptor(CrudController.prototype, 'query')!);
    if (routes.query?.decorators) {
      for (const decorator of routes.query.decorators) {
        decorator(CrudController.prototype, 'query', Object.getOwnPropertyDescriptor(CrudController.prototype, 'query')!);
      }
    }
  }

  if (routes.findOne?.enabled !== false) {
    CrudController.prototype.findOne = async function (id: string) {
      return this.service.findOne(id);
    };
    Get(':id')(CrudController, 'findOne', Object.getOwnPropertyDescriptor(CrudController.prototype, 'findOne')!);
  }

  if (routes.create?.enabled !== false) {
    CrudController.prototype.create = async function (body: any) {
      return this.service.create(body);
    };
    Post()(CrudController, 'create', Object.getOwnPropertyDescriptor(CrudController.prototype, 'create')!);
  }

  if (routes.update?.enabled !== false) {
    CrudController.prototype.update = async function (id: string, body: any) {
      return this.service.update(id, body);
    };
    Put(':id')(CrudController, 'update', Object.getOwnPropertyDescriptor(CrudController.prototype, 'update')!);
  }

  if (routes.delete?.enabled !== false) {
    CrudController.prototype.remove = async function (id: string) {
      if (options.softDelete) {
        return this.service.softDelete(id);
      }
      return this.service.delete(id);
    };
    Delete(':id')(CrudController, 'remove', Object.getOwnPropertyDescriptor(CrudController.prototype, 'remove')!);
  }

  SetMetadata(CRUD_METADATA, options)(CrudController);

  return CrudController as any;
}
