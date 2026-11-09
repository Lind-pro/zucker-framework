/**
 * PermissionsController — admin 后台权限管理接口
 *
 * 端点列表：
 * - POST /permissions/_query  — 分页查询权限
 * - POST /permissions/_count  — 查询权限总数
 * - GET  /permissions         — 全量查询（无分页，用于角色编辑时的权限选择）
 * - GET  /permissions/tree    — 按 resource 分组的权限树
 * - POST /permissions         — 创建权限
 * - PUT  /permissions/:id     — 更新权限
 * - DELETE /permissions/:id   — 删除权限
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Inject,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, Permissions, PermissionService, PermissionSyncService } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { adminPage, toAdminWhere, type AdminQueryFilterOptions } from '../query-filter';

/** Filterable permission fields (allow-list). */
export const PERMISSION_FILTER: AdminQueryFilterOptions = { eq: ['id', 'name', 'status'], like: ['id', 'name', 'description'] };

/** Flat DB record for a permission (not the interface with runtime methods). */
interface PermissionRecord {
  id: string;
  name: string;
  actions: string[];
  describe?: string;
  status?: boolean;
  /** Optional resource grouping field (e.g. 'user', 'order'). */
  resource?: string;
  [key: string]: unknown;
}

/** Tree node grouping permissions by resource. */
interface PermissionTreeNode {
  resource: string;
  permissions: PermissionRecord[];
}

interface QueryRequest {
  pageIndex?: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}

interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

interface CountResult {
  total: number;
}

/** Definition metadata only. Memberships use the separate authorization endpoints. */
function permissionInput(body: unknown, existingId?: string): Record<string, unknown> {
  const allowed = new Set(['id', 'name', 'description', 'status', 'actions', 'optionalFields', 'parents', 'properties']);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.has(key)))
    throw new BadRequestException('Unsupported permission fields');
  const input = body as Record<string, unknown>;
  if (existingId === undefined && (typeof input.id !== 'string' || !input.id.trim()
    || typeof input.name !== 'string' || !input.name.trim()))
    throw new BadRequestException('Permission identifier and name are required');
  if (existingId !== undefined && input.id !== undefined && input.id !== existingId)
    throw new BadRequestException('Permission identifiers cannot be changed');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())
    || input.description !== undefined && input.description !== null && typeof input.description !== 'string'
    || input.status !== undefined && typeof input.status !== 'boolean')
    throw new BadRequestException('Invalid permission metadata');
  for (const key of ['actions', 'optionalFields', 'parents'])
    if (input[key] !== undefined && input[key] !== null && !Array.isArray(input[key]))
      throw new BadRequestException(`Permission ${key} must be an array`);
  if (input.properties !== undefined && input.properties !== null
    && (typeof input.properties !== 'object' || Array.isArray(input.properties)))
    throw new BadRequestException('Permission properties must be an object');
  const { id, ...metadata } = input;
  if (existingId !== undefined && !Object.keys(metadata).length)
    throw new BadRequestException('No permission changes were supplied');
  return existingId === undefined ? { id, ...metadata } : metadata;
}

@Controller('permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('permissions:query')
export class PermissionsController {
  private readonly logger = new Logger(PermissionsController.name);

  constructor(
    private readonly permissionService: PermissionService,
    private readonly permissionSyncService: PermissionSyncService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /**
   * POST /permissions/_query — 分页查询权限
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequest): Promise<PageResult<PermissionRecord>> {
    const { pageIndex, pageSize } = adminPage(body);
    const filter = toAdminWhere(body.filter, PERMISSION_FILTER);
    const permissions = this.db.model('permissions');
    const [data, total] = await Promise.all([
      permissions.findMany({ where: filter, orderBy: [{ id: 'asc' }], skip: pageIndex * pageSize, take: pageSize }) as Promise<PermissionRecord[]>,
      permissions.count({ where: filter }),
    ]);
    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /permissions/_count — 查询权限总数
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async count(@Body() body: { filter?: Record<string, unknown> }): Promise<CountResult> {
    return { total: await this.db.model('permissions').count({ where: toAdminWhere(body.filter, PERMISSION_FILTER) }) };
  }

  /**
   * GET /permissions — 全量查询（无分页），用于角色编辑时的权限选择
   */
  @Get()
  async findAll(): Promise<PermissionRecord[]> {
    return this.loadAll({});
  }

  /**
   * GET /permissions/tree — 按 resource 字段分组的权限树
   * 注意：此路由必须在 GET /permissions/:id 之前声明，避免被 :id 拦截
   */
  @Get('tree')
  async tree(): Promise<PermissionTreeNode[]> {
    const records = await this.loadAll({});

    const grouped = new Map<string, PermissionRecord[]>();
    for (const record of records) {
      const key = record.resource ?? record.id.split(':')[0] ?? 'other';
      const group = grouped.get(key) ?? [];
      group.push(record);
      grouped.set(key, group);
    }

    return Array.from(grouped.entries()).map(([resource, permissions]) => ({
      resource,
      permissions,
    }));
  }

  /**
   * GET /permissions/:id — 查询单个权限
   */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<PermissionRecord> {
    const record = await this.loadById(id);
    if (!record) {
      throw new NotFoundException(`Permission ${id} not found`);
    }
    return record;
  }

  /**
   * POST /permissions — 创建权限
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('permissions:add')
  async create(@Body() body: unknown): Promise<PermissionRecord> {
    const input = permissionInput(body);
    let created: unknown;
    try {
      created = await this.db.model('permissions').create({ data: { actions: [], status: true, ...input } });
    } catch (error) {
      // The permission code is the primary key; a duplicate is a client conflict, not a server fault.
      if ((error as { code?: unknown })?.code === 'P2002') throw new ConflictException(`Permission ${String(input.id)} already exists`);
      throw error;
    }

    // Invalidate permission cache so new permissions are immediately effective
    this.permissionService.invalidatePermissionCache();

    return created as PermissionRecord;
  }

  /**
   * PUT /permissions/:id — 更新权限
   */
  @Put(':id')
  @Permissions('permissions:update')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PermissionRecord> {
    const updateData = permissionInput(body, id);
    const existing = await this.loadById(id);
    if (!existing) {
      throw new NotFoundException(`Permission ${id} not found`);
    }

    await this.db.model('permissions').update({
      where: { id },
      data: updateData,
    });

    // Invalidate cache so updated permissions are picked up immediately
    this.permissionService.invalidatePermissionCache();

    return { ...existing, ...updateData, id };
  }

  /**
   * DELETE /permissions/:id — 删除权限
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('permissions:delete')
  async remove(@Param('id') id: string): Promise<void> {
    const existing = await this.loadById(id);
    if (!existing) {
      throw new NotFoundException(`Permission ${id} not found`);
    }

    // 事务保障：删除关联数据和权限本身
    await this.db.$transaction(async (tx) => {
      await tx.model('rolePermissions').deleteMany({
        where: { permissionId: id },
      });
      await tx.model('permissions').delete({ where: { id } });
    });

    this.permissionService.invalidatePermissionCache();
  }

  /**
   * POST /permissions/_sync — 扫描代码中的 @Permissions/@Resource 装饰器，同步到数据库
   */
  @Post('_sync')
  @HttpCode(HttpStatus.OK)
  @Permissions('permissions:update')
  async syncPermissions(): Promise<{ synced: number }> {
    const result = await this.permissionSyncService.synchronize();
    this.permissionService.invalidatePermissionCache();
    return { synced: result.created + result.updated };
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private async loadAll(filter: Record<string, unknown>): Promise<PermissionRecord[]> {
    // PermissionService.findUserPermissions is for auth checks.
    // For admin CRUD we access the underlying DB through the service's private db.
    // This avoids duplicating DB injection and stays DRY.
    return this.db.model('permissions').findMany({
      where: filter,
    }) as Promise<PermissionRecord[]>;
  }

  private async loadById(id: string): Promise<PermissionRecord | null> {
    return this.db.model('permissions').findUnique({
      where: { id },
    }) as Promise<PermissionRecord | null>;
  }
}
