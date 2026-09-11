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
} from '@nestjs/common';
import { ApiResponse, ApiOperation } from '@nestjs/swagger';
import type { CrudEntity } from './crud-entity';
import { CrudService } from './base.service';
import { type DynamicQueryParam } from './dynamic-query.service';

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
export interface BaseControllerOptions {
  /** Restrict the generated HTTP surface to these operations. Defaults to existing standard routes. */
  only?: readonly BaseControllerMethod[];
  routes?: Partial<Record<BaseControllerMethod, BaseControllerRouteOptions | false>>;
  /** Runtime query DTO for the host's validation/defaults policy. */
  queryDto?: Type<DynamicQueryParam>;
}
export function BaseController<T extends CrudEntity>(
  EntityClass: Type<T>,
  options: BaseControllerOptions = {},
): Type<BaseControllerHost<T>> {
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
      return this.service.saveOrUpdate(data);
    }

    // ===================== Save Routes  =====================

    /**
     * 新增单个数据,并返回新增后的数据
     */
    @Post()
    @ApiOperation({ summary: '新增单个数据,并返回新增后的数据' })
    @ApiResponse({ status: HttpStatus.CREATED, type: EntityClass })
    async create(@Body() data: Partial<T>): Promise<T> {
      return this.service.create(data);
    }

    /**
     * 批量新增
     */
    @Post('_batch')
    @ApiOperation({ summary: '批量新增数据' })
    @ApiResponse({ status: HttpStatus.CREATED })
    async createMany(@Body() data: Partial<T>[]): Promise<{ count: number }> {
      return this.service.createMany(data);
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
      return this.service.save(data);
    }

    /**
     * 根据ID修改数据
     */
    @Put(':id')
    @ApiOperation({ summary: '根据ID修改数据' })
    @ApiResponse({ status: HttpStatus.OK, type: EntityClass })
    async update(@Param('id') id: string, @Body() data: Partial<T>): Promise<T> {
      return this.service.update(id, data);
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

    /**
     * 批量更新记录
     */
    @Put('batch')
    @ApiOperation({ summary: '批量更新记录' })
    @ApiResponse({ status: HttpStatus.OK })
    async updateMany(
      @Body('where') where: Record<string, unknown>,
      @Body('data') data: Partial<T>,
    ): Promise<{ count: number }> {
      if (!where || Object.keys(where).length === 0) {
        throw new BadRequestException('deleteMany/updateMany 不允许空 where 条件');
      }
      return this.service.updateMany(where, data);
    }

    /**
     * 批量删除记录
     */
    @Delete('batch')
    @ApiOperation({ summary: '批量删除记录' })
    @ApiResponse({ status: HttpStatus.OK })
    async deleteMany(@Body('where') where: Record<string, unknown>): Promise<{ count: number }> {
      if (!where || Object.keys(where).length === 0) {
        throw new BadRequestException('deleteMany/updateMany 不允许空 where 条件');
      }
      return this.service.deleteMany(where);
    }
  }

  const prototype = BaseControllerHostImpl.prototype;
  const verbs = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Delete };
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const key = name as BaseControllerMethod;
    const route = options.routes?.[key];
    const enabled = options.only
      ? options.only.includes(key)
      : key !== 'saveOrUpdate' || route !== undefined;
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
  if (options.queryDto && Object.hasOwn(prototype, 'findAll')) {
    Reflect.defineMetadata('design:paramtypes', [options.queryDto], prototype, 'findAll');
  }

  return BaseControllerHostImpl as unknown as Type<BaseControllerHost<T>>;
}
