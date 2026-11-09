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

/**
 * Returned fields. A list keeps model field names; a record maps response keys to model fields
 * (`{ userId: 'subjectId' }`). With a projection, filters and `id` use response keys and only the
 * projected columns are selected from storage.
 */
export type ReadOnlyProjection = readonly string[] | Readonly<Record<string, string>>;

export interface ReadOnlyAdminOptions {
  path: string;
  model: string;
  resource: Parameters<typeof Resource>[0];
  filters: readonly string[];
  enumFilters?: Record<string, readonly string[]>;
  orderBy: Record<string, 'asc' | 'desc'>;
  guards?: Type<CanActivate>[];
  maxPageSize?: number;
  /** Omit to return whole records (the former behavior); set it for models with private fields. */
  projection?: ReadOnlyProjection;
}

export type ReadOnlyRecordOptions = Pick<
  ReadOnlyAdminOptions,
  'model' | 'filters' | 'enumFilters' | 'orderBy' | 'maxPageSize' | 'projection'
>;
export interface ReadOnlyPage {
  data: unknown[];
  total: number;
  page: number;
  pageSize: number;
}

function pageNumber(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new BadRequestException('Invalid page number');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new BadRequestException('Invalid page number');
  return parsed;
}

/** Bounded paging, allowlisted equality filters and optional field projection over one model. */
export function createReadOnlyRecordReader(options: ReadOnlyRecordOptions) {
  const projection: Readonly<Record<string, string>> | undefined = options.projection
    ? Array.isArray(options.projection)
      ? Object.fromEntries((options.projection as readonly string[]).map((key) => [key, key]))
      : (options.projection as Readonly<Record<string, string>>)
    : undefined;
  if (projection) {
    if (!Object.keys(projection).length) throw new Error('Projection must contain fields');
    for (const field of [...options.filters, ...Object.keys(options.enumFilters ?? {})])
      if (!Object.hasOwn(projection, field)) throw new Error(`Filter ${field} must be projected`);
  }
  const column = (key: string) => projection?.[key] ?? key;
  const idFilterable = !projection || Object.hasOwn(projection, 'id');
  const select = projection
    ? Object.fromEntries(Object.values(projection).map((field) => [field, true]))
    : undefined;
  const present = (row: unknown) =>
    projection && row && typeof row === 'object'
      ? Object.fromEntries(
          Object.entries(projection).map(([key, field]) => [
            key,
            (row as Record<string, unknown>)[field] ?? null,
          ]),
        )
      : row;

  return {
    async findAll(database: DatabaseAdapter, query: Record<string, unknown>): Promise<ReadOnlyPage> {
      const page = pageNumber(query.page, 1);
      const pageSize = Math.min(pageNumber(query.pageSize, 20), options.maxPageSize ?? 100);
      const where: Record<string, string> = {};
      // `id` is filterable only when the projection exposes it (composite-key models have none).
      const fields = [...(idFilterable ? ['id'] : []), ...options.filters];
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
        where[column(field)] = value;
      }
      const model = database.model(options.model);
      const [data, total] = await Promise.all([
        model.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: options.orderBy,
          ...(select ? { select } : {}),
        }),
        model.count({ where }),
      ]);
      return { data: data.map(present), total, page, pageSize };
    },
    async findOne(database: DatabaseAdapter, id: string): Promise<unknown> {
      const row = await database
        .model(options.model)
        .findUnique({ where: { [column('id')]: id }, ...(select ? { select } : {}) });
      return present(row);
    },
  };
}

/** A bounded read-only record API. It exposes no inherited mutation or arbitrary-query routes. */
export function createReadOnlyAdminController(options: ReadOnlyAdminOptions): Type<unknown> {
  const reader = createReadOnlyRecordReader(options);

  @Controller(options.path)
  @Resource(options.resource)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class ReadOnlyController {
    constructor(@Inject(DATABASE_ADAPTER) readonly database: DatabaseAdapter) {}

    @Get()
    @QueryAction()
    findAll(@Query() query: Record<string, unknown>) {
      return reader.findAll(this.database, query);
    }

    @Get(':id')
    @QueryAction()
    findOne(@Param('id') id: string) {
      return reader.findOne(this.database, id);
    }
  }
  return ReadOnlyController;
}
