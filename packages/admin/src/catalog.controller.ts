import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter, type GenericEntity } from '@zucker-framework/core';
import { BaseService, DynamicQueryService } from '@zucker-framework/crud';
import {
  Action,
  DeleteAction,
  JwtAuthGuard,
  PermissionsGuard,
  QueryAction,
  Resource,
  UpdateAction,
} from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';

export interface CatalogField {
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required?: boolean;
  default?: unknown;
}
export interface CatalogAdminOptions {
  path: string;
  model: string;
  resource: Parameters<typeof Resource>[0];
  guards?: Type<CanActivate>[];
  createFields: Record<string, CatalogField>;
  updateFields: Record<string, CatalogField>;
  where: (query: Record<string, unknown>) => Record<string, unknown>;
  orderBy: unknown;
  listInclude?: Record<string, unknown>;
  detailInclude?: Record<string, unknown>;
  softDeleteField: string;
  paginated?: boolean;
  pageSize?: number;
  createAction?: string;
}

/** Configured catalog CRUD with bounded reads, field allowlists and soft deletion. */
export interface CatalogAdminController {
  list(query: Record<string, unknown>): Promise<unknown>;
  detail(id: string): Promise<unknown>;
  create(body: Record<string, unknown>): Promise<unknown>;
  update(id: string, body: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}
export function createCatalogAdminController(
  options: CatalogAdminOptions,
): Type<CatalogAdminController> {
  function write(body: Record<string, unknown>, fields: Record<string, CatalogField>) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Invalid catalog data');
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(body))
      if (!Object.hasOwn(fields, key)) throw new BadRequestException(`Unsupported field: ${key}`);
    for (const [key, field] of Object.entries(fields)) {
      const value = body[key] ?? field.default;
      if (value === undefined) {
        if (field.required) throw new BadRequestException(`${key} is required`);
        continue;
      }
      const valid =
        field.type === 'string[]'
          ? Array.isArray(value) && value.every((v) => typeof v === 'string')
          : typeof value === field.type && (field.type !== 'number' || Number.isFinite(value));
      if (!valid || (field.required && typeof value === 'string' && !value.trim()))
        throw new BadRequestException(`Invalid ${key}`);
      data[key] = value;
    }
    return data;
  }
  function positive(value: unknown, fallback: number) {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new BadRequestException('Invalid page');
    return number;
  }
  class CatalogService extends BaseService<GenericEntity & Record<string, unknown>> {}
  @Controller(options.path)
  @Resource(options.resource)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class CatalogController {
    private readonly service: CatalogService;
    constructor(
      @Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
      @Inject(DynamicQueryService) query: DynamicQueryService,
    ) {
      this.service = new CatalogService(database, query, options.model);
    }
    @Get()
    @QueryAction()
    async list(@Query() query: Record<string, unknown>) {
      const model = this.database.model(options.model);
      const where = options.where(query);
      const args = { where, include: options.listInclude, orderBy: options.orderBy };
      if (options.paginated === false) return model.findMany(args);
      const page = positive(query.page, 1),
        pageSize = Math.min(200, positive(query.pageSize, options.pageSize ?? 20));
      const [data, total] = await Promise.all([
        model.findMany({ ...args, skip: (page - 1) * pageSize, take: pageSize }),
        model.count({ where }),
      ]);
      return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    }
    @Get(':id')
    @QueryAction()
    async detail(@Param('id') id: string) {
      const record = await this.database
        .model(options.model)
        .findUnique({ where: { id }, include: options.detailInclude });
      if (!record) throw new NotFoundException('Catalog record not found');
      return record;
    }
    @Post()
    @Action({ action: options.createAction ?? 'add', name: '新增', description: '新增目录记录' })
    @AccessLogger({
      module: options.resource.id,
      action: 'create',
      describe: '创建目录记录',
      logParameters: true,
    })
    create(@Body() body: Record<string, unknown>) {
      return this.service.create(write(body, options.createFields));
    }
    @Put(':id')
    @UpdateAction()
    @AccessLogger({
      module: options.resource.id,
      action: 'update',
      describe: '更新目录记录',
      logParameters: true,
    })
    update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
      return this.service.update(id, write(body, options.updateFields));
    }
    @Delete(':id')
    @DeleteAction()
    @AccessLogger({ module: options.resource.id, action: 'delete', describe: '停用目录记录' })
    remove(@Param('id') id: string) {
      return this.service.update(id, { [options.softDeleteField]: false });
    }
  }
  return CatalogController;
}
