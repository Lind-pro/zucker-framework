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
 * - PUT  /users/:id/roles       — 设置用户角色（全量替换；roleAssignments.expiry 开启时可带 expiries）
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
  Optional,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  PermissionsGuard,
  Permissions,
  UserService,
  PermissionService,
  DimensionUserService,
  ROLE_ASSIGNMENT_OPTIONS,
  type ResolvedRoleAssignmentOptions,
} from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { type DatabaseAdapter, ValidationException } from '@zucker-framework/core';
import type { UserEntity } from '@zucker-framework/auth';
import { adminPage, toAdminWhere, type AdminQueryFilterOptions } from '../query-filter';
import { isPrivilegedCode, isSuperadminUser, privilegedRoleCodes } from '../privileged-grants';
import {
  ADMIN_USERS_OPTIONS,
  ADMIN_USER_HOOKS,
  USER_CREATE_FIELDS,
  USER_PROFILE_FIELDS,
  USER_READABLE_FIELDS,
  USER_SENSITIVE_FIELDS,
  type AdminUserHooks,
  type UsersAdminOptions,
} from './users.options';

type AdminRequest = { user?: { id?: string } } | undefined;

/** Role id → ISO expiry (`null` = never expires). */
export type RoleExpiries = Record<string, string | null>;

/** Full ISO 8601 date-time with an explicit offset: a bare date would be read as UTC midnight. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Forms send `''` for an empty optional field that is stored as `null`; that is not a change. */
const sameStoredValue = (next: unknown, stored: unknown): boolean =>
  next === stored || ((next === '' || next == null) && (stored === '' || stored == null));
type UserView = Partial<Omit<UserEntity, 'password'>>;

/**
 * Filterable user fields (allow-list). Credentials, login metadata and every column added later stay
 * unfilterable unless listed here.
 */
export const USER_FILTER: AdminQueryFilterOptions = { eq: ['id', 'username', 'name', 'status'], like: ['username', 'email', 'name'] };

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
@Permissions('users:query')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly userService: UserService,
    private readonly permissionService: PermissionService,
    private readonly dimensionUserService: DimensionUserService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(ADMIN_USERS_OPTIONS) options?: UsersAdminOptions,
    @Optional() @Inject(ADMIN_USER_HOOKS) private readonly hooks?: AdminUserHooks,
    @Optional() @Inject(ROLE_ASSIGNMENT_OPTIONS) roleAssignments?: ResolvedRoleAssignmentOptions,
  ) {
    this.options = options ?? {};
    // Only when the auth module was configured with roleAssignments.expiry: the column may not exist.
    this.roleExpiry = roleAssignments?.expiry === true;
  }

  private readonly roleExpiry: boolean;

  private readonly options: UsersAdminOptions;

  /**
   * POST /users/_query — 分页查询用户
   * Body: { pageIndex?: number, pageSize?: number, filter?: Record<string, unknown> }
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequest): Promise<PageResult<UserView>> {
    const { pageIndex, pageSize } = adminPage(body);
    const filter = toAdminWhere(body.filter, USER_FILTER);
    const users = this.db.model('users');
    // Paged and ordered in the database; only one page of rows is read and serialized.
    const [page, total] = await Promise.all([
      users.findMany({ where: filter, orderBy: [{ id: 'asc' }], skip: pageIndex * pageSize, take: pageSize }) as Promise<UserEntity[]>,
      users.count({ where: filter }),
    ]);
    const data = page.map(user => this.view(user));

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /users/_count — 统计用户总数
   * Body: { filter?: Record<string, unknown> }
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async count(@Body() body: { filter?: Record<string, unknown> }): Promise<CountResult> {
    const total = await this.userService.countUsers(toAdminWhere(body.filter, USER_FILTER));
    return { total };
  }

  /**
   * GET /users/:id — 查询单个用户
   */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserView> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return this.view(user);
  }

  /**
   * POST /users — 创建用户
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('users:add')
  async create(@Body() body: unknown, @Req() request?: AdminRequest): Promise<UserView> {
    const input = this.writableBody(body, [...USER_CREATE_FIELDS, ...(this.options.writableFields ?? [])]);
    if (typeof input.username !== 'string' || !input.username.trim())
      throw new ValidationException({ username: ['Required'] }, 'Invalid user');
    if (typeof input.password !== 'string' || !input.password)
      throw new ValidationException({ password: ['Required'] }, 'Invalid user');
    // The creator is the authenticated administrator, never a client-supplied value.
    const created = await this.userService.addUser({
      ...(input as Partial<UserEntity> & { username: string; password: string }),
      ...(request?.user?.id ? { creatorId: request.user.id } : {}),
    });
    return this.view(created);
  }

  /**
   * PUT /users/:id — 更新用户
   *
   * Only allow-listed fields are written. Changing `password`, `email`, `emailVerified`, `status`
   * or `typeId` additionally requires `users:authorize`, and accounts holding `superadmin` can only
   * be changed by a superadmin.
   */
  @Put(':id')
  @Permissions('users:update')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request?: AdminRequest,
  ): Promise<UserView> {
    const input = this.writableBody(body, [
      ...USER_PROFILE_FIELDS, ...USER_SENSITIVE_FIELDS, ...(this.options.writableFields ?? []),
    ]);
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException(`User ${id} not found`);
    }
    await this.requireNotOutranked(request, id);
    const sensitive = (USER_SENSITIVE_FIELDS as readonly string[]).filter(field => field in input
      && (field === 'password' ? !!input.password : !sameStoredValue(input[field], existing[field])));
    if (sensitive.length) await this.requirePermission(request, 'users:authorize',
      `Changing ${sensitive.join(', ')} requires users:authorize`);
    // updateUser never inserts: a row deleted after the check above fails instead of being recreated.
    const updated = await this.userService.updateUser(id, input as Partial<UserEntity>);
    if (sensitive.length && this.hooks?.sensitiveFieldsChanged) {
      await this.hooks.sensitiveFieldsChanged({ userId: id, fields: sensitive, actorId: request?.user?.id });
    }
    return this.view(updated);
  }

  /**
   * DELETE /users/:id — 删除用户
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('users:delete')
  async remove(@Param('id') id: string, @Req() request?: AdminRequest): Promise<void> {
    await this.ensureUserExists(id);
    await this.requireNotOutranked(request, id);
    // Optional table: removed outside the transaction, because a failing statement would abort a
    // PostgreSQL transaction and make the user undeletable when the table is absent.
    await this.db.model('dimensionUsers').deleteMany({ where: { userId: id } }).catch((error: unknown) => {
      this.logger.debug(`dimensionUsers cleanup skipped for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.db.$transaction(async (tx) => {
      await tx.model('userRoles').deleteMany({ where: { userId: id } });
      await tx.model('userPermissions').deleteMany({ where: { userId: id } });
      await tx.model('users').delete({ where: { id } });
    });
    this.permissionService.invalidatePermissionCache(id);
    await this.hooks?.userDeleted?.(id, request?.user?.id);
  }

  // ─── 用户-角色关联 ────────────

  /**
   * GET /users/:id/roles — 查询用户角色列表
   */
  @Get(':id/roles')
  async getUserRoles(
    @Param('id') id: string,
  ): Promise<{ roleIds: string[]; roles: unknown[]; expiries?: RoleExpiries }> {
    await this.ensureUserExists(id);
    // Lists every link, expired ones included, so an operator can see and renew them.
    const links = (await this.db.model('userRoles').findMany({
      where: { userId: id },
    })) as Array<{ roleId: string; expiresAt?: Date | string | null }>;
    const roleIds = links.map((l) => l.roleId);
    const roles = roleIds.length > 0
      ? await Promise.all(roleIds.map((rid) => this.db.model('roles').findUnique({ where: { id: rid } })))
      : [];
    if (!this.roleExpiry) return { roleIds, roles: roles.filter(Boolean) };
    const expiries: RoleExpiries = {};
    for (const link of links) {
      const at = link.expiresAt == null ? null : new Date(link.expiresAt);
      expiries[link.roleId] = at && Number.isFinite(at.getTime()) ? at.toISOString() : null;
    }
    return { roleIds, roles: roles.filter(Boolean), expiries };
  }

  /**
   * PUT /users/:id/roles — 设置用户角色（全量替换）
   * Body: { roleIds: string[], expiries?: { [roleId]: ISO date-time | null } }
   *
   * `expiries` is accepted only when the auth module runs with `roleAssignments.expiry`;
   * otherwise it is rejected with 400. Roles without an entry never expire.
   */
  @Put(':id/roles')
  @Permissions('users:authorize')
  async setUserRoles(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request?: AdminRequest,
  ): Promise<{ roleIds: string[]; expiries?: RoleExpiries }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'roleIds' && key !== 'expiries')
      || !('roleIds' in body) || !Array.isArray(body.roleIds)
      || body.roleIds.some(roleId => typeof roleId !== 'string' || !roleId.trim()))
      throw new ValidationException({ roleIds: ['Must be an array of non-empty role identifiers'] }, 'Invalid roles');
    const roleIds = [...new Set(body.roleIds as string[])];
    const expiries = 'expiries' in body ? this.roleExpiriesBody(body.expiries, roleIds) : undefined;
    await this.requireNotOutranked(request, id);
    await this.db.$transaction(async (tx) => {
      // A same-value parent update locks this user before reading/replacing child rows.
      // Locking only existing links would allow concurrent replacements of an empty set to merge.
      const locked = await tx.model('users').updateMany({ where: { id }, data: { id } });
      if (!locked.count) throw new NotFoundException(`User ${id} not found`);
      // Pin referenced roles through commit; deletion follows the same role -> link order.
      // Sorting prevents two users assigning the same roles in opposite order from deadlocking.
      for (const roleId of [...roleIds].sort()) {
        const role = await tx.model('roles').updateMany({ where: { id: roleId }, data: { id: roleId } });
        if (!role.count)
          throw new ValidationException({ roleIds: [`Role not found: ${roleId}`] }, 'Invalid roles');
      }
      // Roles are pinned, so the privilege check below reads what will be committed.
      await this.requireMayGrant(request, await privilegedRoleCodes(tx, roleIds));
      await tx.model('userRoles').deleteMany({ where: { userId: id } });
      for (const roleId of roleIds) {
        // Without expiry support the column is never named (other consumers' tables lack it).
        const data = this.roleExpiry
          ? { userId: id, roleId, expiresAt: expiries?.[roleId] ? new Date(expiries[roleId]!) : null }
          : { userId: id, roleId };
        await tx.model('userRoles').create({ data });
      }
    });
    this.permissionService.invalidatePermissionCache(id);
    if (!this.roleExpiry) return { roleIds };
    return { roleIds, expiries: Object.fromEntries(roleIds.map(roleId => [roleId, expiries?.[roleId] ?? null])) };
  }

  /** Validate `expiries`: only with expiry support, keys among `roleIds`, values ISO date-time or null. */
  private roleExpiriesBody(value: unknown, roleIds: readonly string[]): RoleExpiries {
    if (!this.roleExpiry)
      throw new ValidationException({ expiries: ['Role expiry is not enabled on this server'] }, 'Invalid roles');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ValidationException({ expiries: ['Must be an object of role id to ISO date-time or null'] }, 'Invalid roles');
    const known = new Set(roleIds);
    const result: RoleExpiries = {};
    for (const [roleId, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!known.has(roleId))
        throw new ValidationException({ expiries: [`Role is not in roleIds: ${roleId}`] }, 'Invalid roles');
      if (raw === null) {
        result[roleId] = null;
        continue;
      }
      const at = typeof raw === 'string' && ISO_DATE_TIME.test(raw) ? new Date(raw) : null;
      if (!at || !Number.isFinite(at.getTime()))
        throw new ValidationException({ expiries: [`Invalid ISO date-time for role ${roleId}`] }, 'Invalid roles');
      result[roleId] = at.toISOString();
    }
    return result;
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
  @Permissions('users:authorize')
  async setUserPermissions(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request?: AdminRequest,
  ): Promise<{ permissionIds: string[] }> {
    const input = this.stringListBody(body, 'permissionIds', ['grantType']);
    const grantType = input.extra.grantType ?? 'direct';
    if (typeof grantType !== 'string' || !grantType.trim() || grantType.length > 64)
      throw new ValidationException({ grantType: ['Must be a non-empty string'] }, 'Invalid permissions');
    const permissionIds = input.values;
    await this.requireNotOutranked(request, id);
    await this.requireMayGrant(request, permissionIds.filter(isPrivilegedCode));
    await this.db.$transaction(async (tx) => {
      await this.lockUser(tx, id);
      // Replace only the links of this grant type; other grant types are managed elsewhere.
      await tx.model('userPermissions').deleteMany({ where: { userId: id, grantType } });
      if (grantType === 'direct') await tx.model('userPermissions').deleteMany({ where: { userId: id, grantType: null } });
      for (const permissionId of permissionIds) {
        await tx.model('userPermissions').create({
          data: { userId: id, permissionId, grantType },
        });
      }
    });
    this.permissionService.invalidatePermissionCache(id);
    return { permissionIds };
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
  @Permissions('users:authorize')
  async setUserDimensions(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request?: AdminRequest,
  ): Promise<{ dimensionIds: string[] }> {
    const dimensionIds = this.stringListBody(body, 'dimensionIds', []).values;
    await this.requireNotOutranked(request, id);
    await this.db.$transaction(async (tx) => {
      await this.lockUser(tx, id);
      await tx.model('dimensionUsers').deleteMany({ where: { userId: id } });
      for (const dimensionId of dimensionIds) {
        await tx.model('dimensionUsers').create({
          data: { dimensionId, userId: id },
        });
      }
    });
    this.permissionService.invalidatePermissionCache(id);
    return { dimensionIds };
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────

  private async ensureUserExists(id: string): Promise<void> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }

  /** Explicit response projection: credentials and unlisted consumer columns are never returned. */
  private view(user: UserEntity): UserView {
    const fields = [...USER_READABLE_FIELDS, ...(this.options.readableFields ?? [])];
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field !== 'password' && field in user) result[field] = user[field];
    }
    return result as UserView;
  }

  /** Reject non-objects and any key outside the allow-list (400 names the rejected keys). */
  private writableBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ValidationException({ body: ['Must be an object'] }, 'Invalid user');
    const rejected = Object.keys(body).filter(key => key !== 'id' && key !== 'username' && !allowed.includes(key));
    if (rejected.length)
      throw new ValidationException(Object.fromEntries(rejected.map(key => [key, ['Field is not writable']])), 'Invalid user');
    const input = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
    for (const key of ['name', 'email', 'locale', 'typeId', 'password', 'username'])
      if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string')
        throw new ValidationException({ [key]: ['Must be a string'] }, 'Invalid user');
    for (const key of ['status', 'emailVerified'])
      if (input[key] !== undefined && typeof input[key] !== 'boolean')
        throw new ValidationException({ [key]: ['Must be a boolean'] }, 'Invalid user');
    return input;
  }

  private stringListBody(body: unknown, field: string, extraKeys: string[]): { values: string[]; extra: Record<string, unknown> } {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== field && !extraKeys.includes(key)))
      throw new ValidationException({ [field]: ['Unexpected body'] }, 'Invalid request');
    const record = body as Record<string, unknown>;
    const values = record[field];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 191))
      throw new ValidationException({ [field]: ['Must be an array of non-empty identifiers'] }, 'Invalid request');
    const extra = Object.fromEntries(extraKeys.filter(key => key in record).map(key => [key, record[key]]));
    return { values: [...new Set(values as string[])], extra };
  }

  /** Same-value parent update: locks the user row until commit, serializing link replacements. */
  private async lockUser(tx: DatabaseAdapter, id: string): Promise<void> {
    const locked = await tx.model('users').updateMany({ where: { id }, data: { id } });
    if (!locked.count) throw new NotFoundException(`User ${id} not found`);
  }

  private isSuperadmin(userId: string): Promise<boolean> {
    return isSuperadminUser(this.permissionService, userId);
  }

  /** An account holding superadmin can only be changed by a superadmin. Fails closed without an actor. */
  private async requireNotOutranked(request: AdminRequest, targetId: string): Promise<void> {
    if (!await this.isSuperadmin(targetId)) return;
    const actorId = request?.user?.id;
    if (!actorId || !await this.isSuperadmin(actorId))
      throw new ForbiddenException('Only a superadmin can change a superadmin account');
  }

  /**
   * Granting superadmin (or the `*` wildcard) is itself a superadmin action. Without this an operator
   * with `users:authorize` could make themselves superadmin and then pass {@link requireNotOutranked}.
   */
  private async requireMayGrant(request: AdminRequest, privilegedCodes: readonly string[]): Promise<void> {
    if (!privilegedCodes.length) return;
    const actorId = request?.user?.id;
    if (!actorId || !await this.isSuperadmin(actorId))
      throw new ForbiddenException(`Only a superadmin can grant ${[...new Set(privilegedCodes)].join(', ')}`);
  }

  private async requirePermission(request: AdminRequest, code: string, message: string): Promise<void> {
    const actorId = request?.user?.id;
    if (!actorId || !await this.permissionService.hasPermission(actorId, [code]))
      throw new ForbiddenException(message);
  }
}
