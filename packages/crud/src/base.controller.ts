import {
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  Type,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiResponse, ApiOperation } from '@nestjs/swagger';
import type { CrudEntity } from './crud-entity';
import { CrudService } from './base.service';
import { type DynamicQueryParam } from './dynamic-query.service';
import {
  type CrudWritePolicy,
  assertSafeBatchWhere,
  sanitizeWriteBodies,
  sanitizeWriteBody,
} from './write-policy';

export class BaseControllerHost<T extends CrudEntity> {
  declare protected readonly service: CrudService<T>;

  create(..._args: unknown[]): Promise<T> {
    throw new Error('Not implemented');
  }
  findOne(..._args: unknown[]): Promise<T> {
    throw new Error('Not implemented');
  }
  findAll(..._args: unknown[]): Promise<unknown> {
    throw new Error('Not implemented');
  }
  saveOrUpdate(..._args: unknown[]): Promise<T> {
    throw new Error('Not implemented');
  }
  update(..._args: unknown[]): Promise<T> {
    throw new Error('Not implemented');
  }
  delete(..._args: unknown[]): Promise<T> {
    throw new Error('Not implemented');
  }
  save(..._args: unknown[]): Promise<{ created: number; updated: number; total: number }> {
    throw new Error('Not implemented');
  }
  createMany(..._args: unknown[]): Promise<{ count: number }> {
    throw new Error('Not implemented');
  }
  updateMany(..._args: unknown[]): Promise<{ count: number }> {
    throw new Error('Not implemented');
  }
  deleteMany(..._args: unknown[]): Promise<{ count: number }> {
    throw new Error('Not implemented');
  }
  queryNoPaging(..._args: unknown[]): Promise<T[]> {
    throw new Error('Not implemented');
  }
  queryNoPagingPost(..._args: unknown[]): Promise<T[]> {
    throw new Error('Not implemented');
  }
  queryPager(..._args: unknown[]): Promise<unknown> {
    throw new Error('Not implemented');
  }
  queryPagerPost(..._args: unknown[]): Promise<unknown> {
    throw new Error('Not implemented');
  }
  count(..._args: unknown[]): Promise<{ total: number }> {
    throw new Error('Not implemented');
  }
  countPost(..._args: unknown[]): Promise<{ total: number }> {
    throw new Error('Not implemented');
  }
  exists(..._args: unknown[]): Promise<{ exists: boolean }> {
    throw new Error('Not implemented');
  }
  existsPost(..._args: unknown[]): Promise<{ exists: boolean }> {
    throw new Error('Not implemented');
  }
}

export type BaseControllerMethod = Exclude<keyof BaseControllerHost<CrudEntity>, 'service'>;
export interface BaseControllerRouteOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  decorators?: MethodDecorator[];
}
/** Routes that are only registered when listed in `only` or configured in `routes`. */
const OPT_IN_ROUTES: readonly BaseControllerMethod[] = ['saveOrUpdate', 'updateMany', 'deleteMany'];
const QUERY_ROUTES: readonly BaseControllerMethod[] = [
  'findAll', 'queryNoPaging', 'queryNoPagingPost', 'queryPager', 'queryPagerPost',
  'count', 'countPost', 'exists', 'existsPost',
];

export interface BaseControllerOptions {
  /**
   * Restrict the generated HTTP surface to these operations. Without `only`, the standard routes
   * are registered except the opt-in ones (`saveOrUpdate`, `updateMany`, `deleteMany`), which need
   * to be listed here or configured in `routes`.
   */
  only?: readonly BaseControllerMethod[];
  routes?: Partial<Record<BaseControllerMethod, BaseControllerRouteOptions | false>>;
  /** Runtime query DTO used by Nest validation on every generated query route (GET and POST). */
  queryDto?: Type<DynamicQueryParam>;
  /** Runtime DTO validated (and whitelisted by a whitelisting ValidationPipe) for create bodies. */
  createDto?: Type<unknown>;
  /** Runtime DTO for update / saveOrUpdate bodies. Defaults to `createDto` for saveOrUpdate. */
  updateDto?: Type<unknown>;
  /**
   * Body policy for generated write routes. Defaults: server-controlled audit fields
   * (creatorId, createdAt, updatedAt, deletedAt, ...) are dropped, `id` is dropped on update and
   * Prisma nested relation writes are rejected. See {@link CrudWritePolicy}.
   */
  writePolicy?: CrudWritePolicy;
  /** Max items per createMany / save request (default 1000). */
  maxBatchItems?: number;
  /**
   * Max rows a single `PUT batch` / `DELETE batch` may touch. When set, the matching rows are
   * counted first (with the service's required constraints) and the request fails with 400 above
   * the limit. Default: no limit (the routes are opt-in).
   */
  maxBatchRows?: number;
}

const WRITE_ROUTES: readonly BaseControllerMethod[] = ['create', 'createMany', 'save', 'saveOrUpdate', 'update', 'updateMany'];
export function BaseController<T extends CrudEntity>(
  EntityClass: Type<T>,
  options: BaseControllerOptions = {},
): Type<BaseControllerHost<T>> {
  const writePolicy = options.writePolicy ?? {};
  const maxBatchItems = options.maxBatchItems ?? 1000;

  class BaseControllerHostImpl {
    constructor(protected readonly service: CrudService<T>) {}

    // ===================== Query Routes  =====================

    /**
     * GET 方式查询(不返回分页总数)
     */
    @Get('_query/no-paging')
    @ApiOperation({ summary: '使用GET方式分页动态查询(不返回总数)' })
    @ApiResponse({ status: HttpStatus.OK, type: [EntityClass] })
    async queryNoPaging(@Query() query: DynamicQueryParam): Promise<T[]> {
      const result = await this.service.findAll({ ...query, page: undefined, pageSize: undefined });
      return result.data;
    }

    /**
     * POST 方式查询(不返回分页总数)
     */
    @Post('_query/no-paging')
    @ApiOperation({ summary: '使用POST方式分页动态查询(不返回总数)' })
    @ApiResponse({ status: HttpStatus.OK, type: [EntityClass] })
    async queryNoPagingPost(@Body() query: DynamicQueryParam): Promise<T[]> {
      const result = await this.service.findAll({ ...query, page: undefined, pageSize: undefined });
      return result.data;
    }

    /**
     * GET 方式分页查询
     */
    @Get('_query')
    @ApiOperation({ summary: '使用GET方式分页动态查询' })
    @ApiResponse({ status: HttpStatus.OK })
    async queryPager(@Query() query: DynamicQueryParam) {
      return this.service.queryPager(query);
    }

    /**
     * POST 方式分页查询
     */
    @Post('_query')
    @ApiOperation({ summary: '使用POST方式分页动态查询' })
    @ApiResponse({ status: HttpStatus.OK })
    async queryPagerPost(@Body() query: DynamicQueryParam) {
      return this.service.queryPager(query);
    }

    /**
     * GET 方式查询总数
     */
    @Get('_count')
    @ApiOperation({ summary: '使用GET方式查询总数' })
    @ApiResponse({ status: HttpStatus.OK })
    async count(@Query() query: DynamicQueryParam): Promise<{ total: number }> {
      const total = await this.service.countByQuery(query);
      return { total };
    }

    /**
     * POST 方式查询总数
     */
    @Post('_count')
    @ApiOperation({ summary: '使用POST方式查询总数' })
    @ApiResponse({ status: HttpStatus.OK })
    async countPost(@Body() query: DynamicQueryParam): Promise<{ total: number }> {
      const total = await this.service.countByQuery(query);
      return { total };
    }

    /**
     * GET 方式判断数据是否存在
     */
    @Get('_exists')
    @ApiOperation({ summary: '使用GET方式判断数据是否存在' })
    @ApiResponse({ status: HttpStatus.OK })
    async exists(@Query() query: DynamicQueryParam): Promise<{ exists: boolean }> {
      const result = await this.service.exists(query);
      return { exists: result };
    }

    /**
     * POST 方式判断数据是否存在
     */
    @Post('_exists')
    @ApiOperation({ summary: '使用POST方式判断数据是否存在' })
    @ApiResponse({ status: HttpStatus.OK })
    async existsPost(@Body() query: DynamicQueryParam): Promise<{ exists: boolean }> {
      const result = await this.service.exists(query);
      return { exists: result };
    }

    /**
     * 根据ID查询
     */
    @Get(':id')
    @ApiOperation({ summary: '根据ID查询' })
    @ApiResponse({ status: HttpStatus.OK, type: EntityClass })
    async findOne(@Param('id') id: string): Promise<T> {
      return this.service.findOne(id);
    }

    /**
     * 查询记录列表（兼容旧路由）
     */
    @Get()
    @ApiOperation({ summary: '获取记录列表' })
    @ApiResponse({ status: HttpStatus.OK, type: [EntityClass] })
    async findAll(@Query() query: DynamicQueryParam) {
      return this.service.findAll(query);
    }

    /** Explicitly opt into single-record upsert through routes/only. */
    @Patch('save')
    async saveOrUpdate(@Body() data: Partial<T>): Promise<T> {
      return this.service.saveOrUpdate(sanitizeWriteBody<T>(data, writePolicy, 'create'));
    }

    // Static batch routes are declared before ':id' so PUT/DELETE /batch is not captured by ':id'.

    /**
     * 批量更新记录（需显式启用）
     */
    @Put('batch')
    @ApiOperation({ summary: '批量更新记录' })
    @ApiResponse({ status: HttpStatus.OK })
    async updateMany(
      @Body('where') where: Record<string, unknown>,
      @Body('data') data: Partial<T>,
    ): Promise<{ count: number }> {
      const safeWhere = assertSafeBatchWhere(where, this.service.callerQueryPolicy());
      await this.assertBatchSize(safeWhere);
      return this.service.updateMany(safeWhere, sanitizeWriteBody<T>(data, writePolicy, 'update'));
    }

    /**
     * 批量删除记录（需显式启用）
     */
    @Delete('batch')
    @ApiOperation({ summary: '批量删除记录' })
    @ApiResponse({ status: HttpStatus.OK })
    async deleteMany(@Body('where') where: Record<string, unknown>): Promise<{ count: number }> {
      const safeWhere = assertSafeBatchWhere(where, this.service.callerQueryPolicy());
      await this.assertBatchSize(safeWhere);
      return this.service.deleteMany(safeWhere);
    }

    async assertBatchSize(where: Record<string, unknown>): Promise<void> {
      if (options.maxBatchRows === undefined) return;
      const matched = await this.service.count(where);
      if (matched > options.maxBatchRows) {
        throw new BadRequestException(`Batch matches ${matched} rows; at most ${options.maxBatchRows} allowed`);
      }
    }

    // ===================== Save Routes  =====================

    /**
     * 新增单个数据,并返回新增后的数据
     */
    @Post()
    @ApiOperation({ summary: '新增单个数据,并返回新增后的数据' })
    @ApiResponse({ status: HttpStatus.CREATED, type: EntityClass })
    async create(@Body() data: Partial<T>): Promise<T> {
      return this.service.create(sanitizeWriteBody<T>(data, writePolicy, 'create'));
    }

    /**
     * 批量新增
     */
    @Post('_batch')
    @ApiOperation({ summary: '批量新增数据' })
    @ApiResponse({ status: HttpStatus.CREATED })
    async createMany(@Body() data: Partial<T>[]): Promise<{ count: number }> {
      return this.service.createMany(sanitizeWriteBodies<T>(data, writePolicy, 'create', maxBatchItems));
    }

    /**
     * 保存数据（upsert：有ID则update，无ID则create）
     */
    @Patch()
    @ApiOperation({
      summary: '保存数据',
      description: '如果传入了id,并且对应数据存在,则尝试覆盖,不存在则新增.',
    })
    @ApiResponse({ status: HttpStatus.OK })
    async save(
      @Body() data: Partial<T>[],
    ): Promise<{ created: number; updated: number; total: number }> {
      return this.service.save(sanitizeWriteBodies<T>(data, writePolicy, 'create', maxBatchItems));
    }

    /**
     * 根据ID修改数据
     */
    @Put(':id')
    @ApiOperation({ summary: '根据ID修改数据' })
    @ApiResponse({ status: HttpStatus.OK, type: EntityClass })
    async update(@Param('id') id: string, @Body() data: Partial<T>): Promise<T> {
      return this.service.update(id, sanitizeWriteBody<T>(data, writePolicy, 'update'));
    }

    // ===================== Delete Routes  =====================

    /**
     * 根据ID删除
     */
    @Delete(':id')
    @ApiOperation({ summary: '根据ID删除' })
    @ApiResponse({ status: HttpStatus.OK, type: EntityClass })
    async delete(@Param('id') id: string): Promise<T> {
      return this.service.delete(id);
    }
  }

  const prototype = BaseControllerHostImpl.prototype;
  const verbs = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Delete };
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || name === 'assertBatchSize') continue;
    const key = name as BaseControllerMethod;
    const route = options.routes?.[key];
    const enabled = options.only
      ? options.only.includes(key)
      : !OPT_IN_ROUTES.includes(key) || route !== undefined;
    if (!enabled || route === false) {
      Reflect.deleteProperty(prototype, key);
      continue;
    }
    if (route) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      if (route.method) verbs[route.method](route.path ?? '')(prototype, key, descriptor);
      else if (route.path !== undefined)
        throw new Error('A route path override requires an HTTP method');
      for (const decorator of route.decorators ?? []) decorator(prototype, key, descriptor);
    }
  }
  if (options.queryDto) {
    for (const key of QUERY_ROUTES) {
      if (Object.hasOwn(prototype, key)) {
        Reflect.defineMetadata('design:paramtypes', [options.queryDto], prototype, key);
      }
    }
  }
  const bodyDto = (key: BaseControllerMethod, types: (dto: Type<unknown>) => unknown[], dto?: Type<unknown>) => {
    if (dto && Object.hasOwn(prototype, key)) Reflect.defineMetadata('design:paramtypes', types(dto), prototype, key);
  };
  bodyDto('create', (dto) => [dto], options.createDto);
  bodyDto('update', (dto) => [String, dto], options.updateDto);
  bodyDto('saveOrUpdate', (dto) => [dto], options.updateDto ?? options.createDto);

  const writeRoutes = WRITE_ROUTES.filter((key) => Object.hasOwn(prototype, key));
  if (writeRoutes.length > 0 && !writePolicy.writableFields && !writePolicy.deniedFields?.length && !options.createDto && !options.updateDto) {
    new Logger('BaseController').warn(
      `${EntityClass.name}: write routes [${writeRoutes.join(', ')}] accept every non-audit scalar field ` +
        '(ownerId, tenantId, role, status, ...). Configure writePolicy.writableFields, writePolicy.deniedFields ' +
        'or createDto/updateDto with a whitelisting ValidationPipe.',
    );
  }

  return BaseControllerHostImpl as unknown as Type<BaseControllerHost<T>>;
}
