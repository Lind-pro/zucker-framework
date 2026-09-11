import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, QueryAction, Resource } from '@zucker-framework/auth';

export interface ReadOnlyAdminOptions {
  path: string;
  model: string;
  resource: Parameters<typeof Resource>[0];
  filters: readonly string[];
  enumFilters?: Record<string, readonly string[]>;
  orderBy: Record<string, 'asc' | 'desc'>;
  guards?: Type<CanActivate>[];
  maxPageSize?: number;
}

/** A bounded read-only record API. It exposes no inherited mutation or arbitrary-query routes. */
export function createReadOnlyAdminController(options: ReadOnlyAdminOptions): Type<unknown> {
  function pageNumber(value: unknown, fallback: number) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new BadRequestException('Invalid page number');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new BadRequestException('Invalid page number');
    return parsed;
  }

  @Controller(options.path)
  @Resource(options.resource)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class ReadOnlyController {
    constructor(@Inject(DATABASE_ADAPTER) readonly database: DatabaseAdapter) {}

    @Get()
    @QueryAction()
    async findAll(@Query() query: Record<string, unknown>) {
      const page = pageNumber(query.page, 1);
      const pageSize = Math.min(pageNumber(query.pageSize, 20), options.maxPageSize ?? 100);
      const where: Record<string, string> = {};
      const fields = ['id', ...options.filters];
      let encoded: Record<string, unknown> = {};
      if (query.filters !== undefined) {
        if (typeof query.filters !== 'string') throw new BadRequestException('Invalid filters');
        try {
          const parsed: unknown = JSON.parse(query.filters);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          encoded = parsed as Record<string, unknown>;
        } catch {
          throw new BadRequestException('Invalid filters');
        }
        if (Object.keys(encoded).some((key) => !fields.some((field) => key === `${field}$eq`))) {
          throw new BadRequestException('Only configured equality filters are supported');
        }
      }
      for (const field of fields) {
        const value = query[field] ?? encoded[`${field}$eq`];
        if (value === undefined || value === '') continue;
        if (
          typeof value !== 'string' ||
          (options.enumFilters?.[field] && !options.enumFilters[field].includes(value))
        ) {
          throw new BadRequestException(`Invalid ${field} filter`);
        }
        where[field] = value;
      }
      const model = this.database.model(options.model);
      const [data, total] = await Promise.all([
        model.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: options.orderBy,
        }),
        model.count({ where }),
      ]);
      return { data, total, page, pageSize };
    }

    @Get(':id')
    @QueryAction()
    findOne(@Param('id') id: string) {
      return this.database.model(options.model).findUnique({ where: { id } });
    }
  }
  return ReadOnlyController;
}
