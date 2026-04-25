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
} from '@nestjs/common';
import { NotFoundException } from '@zucker/core';
import { JwtAuthGuard, PermissionsGuard, Permissions, RoleHierarchyService, type RoleEntity } from '@zucker/auth';
import { DATABASE_ADAPTER } from '@zucker/crud';
import type { DatabaseAdapter } from '@zucker/core';

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
@Permissions()
export class RolesController {
  private readonly logger = new Logger(RolesController.name);

  constructor(
    private readonly roleHierarchyService: RoleHierarchyService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /**
   * POST /roles/_query — 分页查询角色
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequest): Promise<PageResult<RoleEntity>> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;
    const filter = body.filter ?? {};

    const allRoles = (await this.db.model('roles').findMany({ where: filter })) as RoleEntity[];
    const total = allRoles.length;
    const start = pageIndex * pageSize;
    const data = allRoles.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /roles/_count — 查询角色总数
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async count(@Body() body: { filter?: Record<string, unknown> }): Promise<CountResult> {
    const roles = (await this.db.model('roles').findMany({
      where: body.filter ?? {},
      select: { id: true },
    })) as Array<{ id: string }>;
    return { total: roles.length };
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
  async create(@Body() body: CreateRoleDto): Promise<RoleWithPermissions> {
    const { permissionIds = [], ...roleData } = body;

    const created = (await this.db.model('roles').create({ data: roleData })) as RoleEntity;

    // Sync role-permission links
    if (permissionIds.length > 0) {
      await this.syncRolePermissions(created.id, permissionIds);
    }

    // Invalidate role hierarchy cache
    this.roleHierarchyService.invalidateCache();

    return { ...created, permissionIds };
  }

  /**
   * PUT /roles/:id — 更新角色（含 permissionIds 同步）
   */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<CreateRoleDto>,
  ): Promise<RoleWithPermissions> {
    const existing = (await this.db.model('roles').findUnique({ where: { id } })) as RoleEntity | null;
    if (!existing) {
      throw new NotFoundException(`Role ${id} not found`);
    }

    const { permissionIds, ...updateData } = body;

    // Update role fields
    await this.db.model('roles').update({ where: { id }, data: updateData });

    // Sync permissions if provided
    let finalPermissionIds: string[];
    if (permissionIds !== undefined) {
      await this.syncRolePermissions(id, permissionIds);
      finalPermissionIds = permissionIds;
    } else {
      const links = (await this.db.model('rolePermissions').findMany({
        where: { roleId: id },
        select: { permissionId: true },
      })) as Array<{ permissionId: string }>;
      finalPermissionIds = links.map((l) => l.permissionId);
    }

    // Invalidate caches
    this.roleHierarchyService.invalidateCache();

    const updated = { ...existing, ...updateData, id };
    return { ...updated, permissionIds: finalPermissionIds };
  }

  /**
   * DELETE /roles/:id — 删除角色
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    const existing = (await this.db.model('roles').findUnique({ where: { id } })) as RoleEntity | null;
    if (!existing) {
      throw new NotFoundException(`Role ${id} not found`);
    }

    // 事务保障：删除关联数据和角色本身
    await this.db.$transaction(async (tx) => {
      await tx.model('rolePermissions').deleteMany({ where: { roleId: id } });
      await tx.model('userRoles').deleteMany({ where: { roleId: id } });
      await tx.model('roles').delete({ where: { id } });
    });

    this.roleHierarchyService.invalidateCache();
  }

  /**
   * Replace all permission links for a role.
   */
  private async syncRolePermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Delete existing links
      await tx.model('rolePermissions').deleteMany({ where: { roleId } });

      // Batch insert new links
      for (const permissionId of permissionIds) {
        await tx.model('rolePermissions').create({
          data: { roleId, permissionId },
        });
      }
    });
  }
}
