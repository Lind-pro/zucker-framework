/**
 * RolesController — admin 后台角色管理接口
 *
 * 端点列表：
 * - POST /roles/_query  — 分页查询角色
 * - POST /roles/_count  — 查询角色总数
 * - GET  /roles/:id     — 查询单个角色（含 permissionIds）
 * - POST /roles         — 创建角色
 * - PUT  /roles/:id     — 更新角色（含 permissionIds 同步）
 * - DELETE /roles/:id   — 删除角色
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
  Req,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, Permissions, PermissionService, RoleHierarchyService, type RoleEntity } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { adminPage, toAdminWhere, type AdminQueryFilterOptions } from '../query-filter';
import { isPrivilegedCode, isSuperadminUser, privilegedRoleCodes } from '../privileged-grants';

/** Filterable role fields (allow-list). */
export const ROLE_FILTER: AdminQueryFilterOptions = { eq: ['id', 'name', 'status', 'parentId', 'groupId'], like: ['name', 'description'] };

interface RoleWithPermissions extends RoleEntity {
  permissionIds: string[];
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

interface CreateRoleDto {
  name: string;
  description?: string;
  parentId?: string;
  permissionIds?: string[];
  [key: string]: unknown;
}

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('roles:query')
export class RolesController {
  private readonly logger = new Logger(RolesController.name);

  constructor(
    private readonly roleHierarchyService: RoleHierarchyService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * POST /roles/_query — 分页查询角色
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequest): Promise<PageResult<RoleEntity>> {
    const { pageIndex, pageSize } = adminPage(body);
    const filter = toAdminWhere(body.filter, ROLE_FILTER);
    const roles = this.db.model('roles');
    // Paged in the database. A stable order keeps pages consistent: without it PostgreSQL may return
    // rows in a different physical order on each request, so a picker could skip or repeat roles.
    const [data, total] = await Promise.all([
      roles.findMany({ where: filter, orderBy: [{ id: 'asc' }], skip: pageIndex * pageSize, take: pageSize }) as Promise<RoleEntity[]>,
      roles.count({ where: filter }),
    ]);
    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /roles/_count — 查询角色总数
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async count(@Body() body: { filter?: Record<string, unknown> }): Promise<CountResult> {
    return { total: await this.db.model('roles').count({ where: toAdminWhere(body.filter, ROLE_FILTER) }) };
  }

  /**
   * GET /roles/:id — 查询单个角色（含 permissionIds）
   */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<RoleWithPermissions> {
    const role = (await this.db.model('roles').findUnique({ where: { id } })) as RoleEntity | null;
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }

    const links = (await this.db.model('rolePermissions').findMany({
      where: { roleId: id },
      select: { permissionId: true },
    })) as Array<{ permissionId: string }>;

    const permissionIds = links.map((l) => l.permissionId);
    return { ...role, permissionIds };
  }

  /**
   * POST /roles — 创建角色
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('roles:add')
  async create(@Body() body: CreateRoleDto, @Req() request: { user: { id: string } }): Promise<RoleWithPermissions> {
    this.validateWriteFields(body);
    await this.requireAuthorization(request.user.id,
      !!body.permissionIds?.length || body.parentId != null || body.name === 'superadmin');
    const { permissionIds = [], ...roleData } = body;

    const created = await this.db.$transaction(async (tx) => {
      await this.requireMayGrant(tx, request.user.id, body, undefined);
      const role = (await tx.model('roles').create({ data: roleData })) as RoleEntity;
      if (permissionIds.length > 0) await this.syncRolePermissions(tx, role.id, permissionIds);
      return role;
    });

    // Invalidate role hierarchy cache
    this.roleHierarchyService.invalidateCache();
    this.permissionService.invalidatePermissionCache();

    return { ...created, permissionIds };
  }

  /**
   * PUT /roles/:id — 更新角色（含 permissionIds 同步）
   */
  @Put(':id')
  @Permissions('roles:update')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<CreateRoleDto>,
    @Req() request: { user: { id: string } },
  ): Promise<RoleWithPermissions> {
    this.validateWriteFields(body);
    const { permissionIds, ...updateData } = body;
    const result = await this.db.$transaction(async (tx) => {
      const existing = await this.lockRole(tx, id);
      // Sensitive comparisons must use the state observed after the parent row lock.
      await this.requireAuthorization(request.user.id, permissionIds !== undefined
        || body.parentId !== undefined || (body.name !== undefined && body.name !== existing.name));
      await this.requireMayGrant(tx, request.user.id, body, existing);
      const updated = (await tx.model('roles').update({ where: { id }, data: updateData })) as RoleEntity;
      if (permissionIds !== undefined) {
        await this.syncRolePermissions(tx, id, permissionIds);
        return { ...updated, permissionIds };
      }
      const links = (await tx.model('rolePermissions').findMany({
        where: { roleId: id }, select: { permissionId: true },
      })) as Array<{ permissionId: string }>;
      return { ...updated, permissionIds: links.map(link => link.permissionId) };
    });

    // Invalidate caches
    this.roleHierarchyService.invalidateCache();
    this.permissionService.invalidatePermissionCache();

    return result;
  }

  /**
   * DELETE /roles/:id — 删除角色
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('roles:delete')
  async remove(@Param('id') id: string): Promise<void> {
    // 事务保障：删除关联数据和角色本身
    await this.db.$transaction(async (tx) => {
      await this.lockRole(tx, id);
      await tx.model('rolePermissions').deleteMany({ where: { roleId: id } });
      await tx.model('userRoles').deleteMany({ where: { roleId: id } });
      await tx.model('roles').delete({ where: { id } });
    });

    this.roleHierarchyService.invalidateCache();
    this.permissionService.invalidatePermissionCache();
  }

  /** Relationship payloads must not bypass the explicit permission assignment path. */
  private validateWriteFields(body: Partial<CreateRoleDto>): void {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid role fields');
    const textFields = ['name', 'code', 'description', 'parentId', 'groupId', 'creatorId'];
    for (const [key, value] of Object.entries(body)) {
      if (key === 'permissionIds') {
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw new BadRequestException('Invalid permission identifiers');
      } else if (key === 'status') {
        if (typeof value !== 'boolean') throw new BadRequestException('Invalid role status');
      } else if (!textFields.includes(key) || (value !== null && typeof value !== 'string')) {
        throw new BadRequestException('Invalid role fields');
      }
    }
  }

  private async requireAuthorization(userId: string, changesAuthorization: boolean): Promise<void> {
    if (changesAuthorization && !await this.permissionService.hasPermission(userId, ['roles:authorize'])) {
      throw new ForbiddenException('Role authorization permission is required');
    }
  }

  /**
   * Making a role confer superadmin (renaming it to `superadmin`, parenting it under a superadmin
   * role or linking `superadmin`/`*`) is a superadmin action; otherwise `roles:authorize` on a role
   * the operator holds would be a path to superadmin.
   */
  private async requireMayGrant(
    tx: DatabaseAdapter, actorId: string, body: Partial<CreateRoleDto>, existing: RoleEntity | undefined,
  ): Promise<void> {
    const parentId = typeof body.parentId === 'string' && body.parentId && body.parentId !== existing?.parentId
      ? body.parentId : undefined;
    const escalates = (body.name === 'superadmin' && existing?.name !== 'superadmin')
      || !!body.permissionIds?.some(isPrivilegedCode)
      || (!!parentId && (await privilegedRoleCodes(tx, [parentId])).length > 0);
    if (escalates && !await isSuperadminUser(this.permissionService, actorId))
      throw new ForbiddenException('Only a superadmin can grant superadmin through a role');
  }

  private async lockRole(tx: DatabaseAdapter, id: string): Promise<RoleEntity> {
    // Lock the parent even when no permission links exist. Role operations never lock users.
    const locked = await tx.model('roles').updateMany({ where: { id }, data: { id } });
    if (!locked.count) throw new NotFoundException(`Role ${id} not found`);
    const role = await tx.model('roles').findUnique({ where: { id } }) as RoleEntity | null;
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }

  /** Replace permission links inside the caller's role mutation transaction. */
  private async syncRolePermissions(tx: DatabaseAdapter, roleId: string, permissionIds: string[]): Promise<void> {
    await tx.model('rolePermissions').deleteMany({ where: { roleId } });
    for (const permissionId of permissionIds) {
      await tx.model('rolePermissions').create({ data: { roleId, permissionId } });
    }
  }
}
