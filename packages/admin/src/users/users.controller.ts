/**
 * UsersController — admin 后台用户管理接口
 *
 * - POST /users/_query  — 分页查询用户（支持 filter 过滤）
 * - POST /users/_count  — 查询用户总数（Dashboard 用）
 * - GET  /users/:id     — 查询单个用户
 * - POST /users         — 创建用户
 * - PUT  /users/:id     — 更新用户
 * - DELETE /users/:id   — 删除用户
 * - GET  /users/:id/roles       — 查询用户角色列表
 * - PUT  /users/:id/roles       — 设置用户角色（全量替换）
 * - GET  /users/:id/permissions  — 查询用户权限（含角色继承）
 * - PUT  /users/:id/permissions  — 直接分配权限给用户
 * - GET  /users/:id/dimensions   — 查询用户维度绑定
 * - PUT  /users/:id/dimensions   — 设置用户维度绑定
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
  NotFoundException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  PermissionsGuard,
  Permissions,
  UserService,
  PermissionService,
  DimensionUserService,
} from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { type DatabaseAdapter, ValidationException } from '@zucker-framework/core';
import type { UserEntity } from '@zucker-framework/auth';

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

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly userService: UserService,
    private readonly permissionService: PermissionService,
    private readonly dimensionUserService: DimensionUserService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /**
   * POST /users/_query — 分页查询用户
   * Body: { pageIndex?: number, pageSize?: number, filter?: Record<string, unknown> }
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequest): Promise<PageResult<Omit<UserEntity, 'password'>>> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;
    if (pageIndex < 0 || pageSize <= 0 || pageSize > 1000) {
      throw new ValidationException(
        { pageIndex: pageIndex < 0 ? ['Must be >= 0'] : [], pageSize: pageSize <= 0 || pageSize > 1000 ? ['Must be between 1 and 1000'] : [] },
        'Invalid pagination parameters',
      );
    }
    const filter = body.filter ?? {};

    const [allUsers, total] = await Promise.all([
      this.userService.findUsers(filter),
      this.userService.countUsers(filter),
    ]);

    // Apply in-memory pagination when the DB adapter does not support skip/take
    const start = pageIndex * pageSize;
    const paged = allUsers.slice(start, start + pageSize);

    const data = paged.map(({ password: _pw, ...rest }) => rest);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /users/_count — 统计用户总数
   * Body: { filter?: Record<string, unknown> }
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async count(@Body() body: { filter?: Record<string, unknown> }): Promise<CountResult> {
    const total = await this.userService.countUsers(body.filter ?? {});
    return { total };
  }

  /**
   * GET /users/:id — 查询单个用户
   */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Omit<UserEntity, 'password'>> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    const { password: _pw, ...rest } = user;
    return rest;
  }

  /**
   * POST /users — 创建用户
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: Partial<UserEntity> & { username: string; password: string },
  ): Promise<Omit<UserEntity, 'password'>> {
    const created = await this.userService.addUser(body);
    const { password: _pw, ...rest } = created;
    return rest;
  }

  /**
   * PUT /users/:id — 更新用户
   */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<UserEntity>,
  ): Promise<Omit<UserEntity, 'password'>> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException(`User ${id} not found`);
    }
    const updated = await this.userService.saveUser({ ...body, id, username: existing.username });
    const { password: _pw, ...rest } = updated;
    return rest;
  }

  /**
   * DELETE /users/:id — 删除用户
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.ensureUserExists(id);
    // 事务保障：删除关联数据和用户本身
    await this.db.$transaction(async (tx) => {
      await tx.model('userRoles').deleteMany({ where: { userId: id } });
      await tx.model('userPermissions').deleteMany({ where: { userId: id } });
      await tx.model('dimensionUsers').deleteMany({ where: { userId: id } }).catch(() => { /* 表可能不存在 */ });
      await tx.model('users').delete({ where: { id } });
    });
  }

  // ─── 用户-角色关联 ────────────

  /**
   * GET /users/:id/roles — 查询用户角色列表
   */
  @Get(':id/roles')
  async getUserRoles(@Param('id') id: string): Promise<{ roleIds: string[]; roles: unknown[] }> {
    await this.ensureUserExists(id);
    const links = (await this.db.model('userRoles').findMany({
      where: { userId: id },
    })) as Array<{ roleId: string }>;
    const roleIds = links.map((l) => l.roleId);
    const roles = roleIds.length > 0
      ? await Promise.all(roleIds.map((rid) => this.db.model('roles').findUnique({ where: { id: rid } })))
      : [];
    return { roleIds, roles: roles.filter(Boolean) };
  }

  /**
   * PUT /users/:id/roles — 设置用户角色（全量替换）
   * Body: { roleIds: string[] }
   */
  @Put(':id/roles')
  async setUserRoles(
    @Param('id') id: string,
    @Body() body: { roleIds: string[] },
  ): Promise<{ roleIds: string[] }> {
    await this.ensureUserExists(id);
    // 验证 roleId 存在性
    if (body.roleIds.length > 0) {
      const existingRoles = (await this.db.model('roles').findMany({
        where: { id: { in: body.roleIds } },
        select: { id: true },
      })) as Array<{ id: string }>;
      const foundIds = new Set(existingRoles.map(r => r.id));
      const missing = body.roleIds.filter(id => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ValidationException({ roleIds: [`Roles not found: ${missing.join(', ')}`] }, 'Invalid roles');
      }
    }
    // 事务保障：先清除再创建，避免并发数据不一致
    await this.db.$transaction(async (tx) => {
      await tx.model('userRoles').deleteMany({ where: { userId: id } });
      for (const roleId of body.roleIds) {
        await tx.model('userRoles').create({ data: { userId: id, roleId } });
      }
    });
    return { roleIds: body.roleIds };
  }

  // ─── 用户-权限关联 ─────────

  /**
   * GET /users/:id/permissions — 查询用户所有权限（含角色继承）
   */
  @Get(':id/permissions')
  async getUserPermissions(@Param('id') id: string): Promise<unknown> {
    await this.ensureUserExists(id);
    return this.permissionService.findUserPermissions(id);
  }

  /**
   * PUT /users/:id/permissions — 直接分配权限给用户
   * Body: { permissionIds: string[], grantType?: string }
   */
  @Put(':id/permissions')
  async setUserPermissions(
    @Param('id') id: string,
    @Body() body: { permissionIds: string[]; grantType?: string },
  ): Promise<{ permissionIds: string[] }> {
    await this.ensureUserExists(id);
    const grantType = body.grantType ?? 'direct';
    await this.db.$transaction(async (tx) => {
      await tx.model('userPermissions').deleteMany({ where: { userId: id } });
      for (const permissionId of body.permissionIds) {
        await tx.model('userPermissions').create({
          data: { userId: id, permissionId, grantType },
        });
      }
    });
    return { permissionIds: body.permissionIds };
  }

  // ─── 用户-维度关联 ────────────────

  /**
   * GET /users/:id/dimensions — 查询用户维度绑定
   */
  @Get(':id/dimensions')
  async getUserDimensions(@Param('id') id: string): Promise<unknown[]> {
    await this.ensureUserExists(id);
    return this.dimensionUserService.findByUserId(id);
  }

  /**
   * PUT /users/:id/dimensions — 设置用户维度绑定（全量替换）
   * Body: { dimensionIds: string[] }
   */
  @Put(':id/dimensions')
  async setUserDimensions(
    @Param('id') id: string,
    @Body() body: { dimensionIds: string[] },
  ): Promise<{ dimensionIds: string[] }> {
    await this.ensureUserExists(id);
    await this.db.$transaction(async (tx) => {
      await tx.model('dimensionUsers').deleteMany({ where: { userId: id } });
      for (const dimensionId of body.dimensionIds) {
        await tx.model('dimensionUsers').create({
          data: { dimensionId, userId: id },
        });
      }
    });
    return { dimensionIds: body.dimensionIds };
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────

  private async ensureUserExists(id: string): Promise<void> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }
}
