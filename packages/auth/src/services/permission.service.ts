import { Injectable, Logger, Optional } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { RoleHierarchyService } from './role-hierarchy.service';

/** TTL-bounded cache for user permissions to avoid redundant DB queries within a short window */
const PERMISSION_CACHE_TTL_MS = 5_000;
const PERMISSION_CACHE_MAX_SIZE = 256;

interface CachedPermissions {
  permissions: string[];
  expiresAt: number;
}

export interface PermissionImportRecord {
  id: string;
  name: string;
  description?: string;
  status?: boolean;
  actions?: unknown[];
  optionalFields?: unknown[];
  parents?: unknown[];
  properties?: Record<string, unknown>;
}
export interface PermissionImportOptions<T extends PermissionImportRecord> {
  mapData?: (permission: T, normalized: Record<string, unknown>) => {
    create: Record<string, unknown>; update: Record<string, unknown>;
  };
  /** Must be a single atomic upsert. The default requires a native model upsert. */
  persist?: (id: string, data: { create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
  successMessage?: string;
}

@Injectable()
export class PermissionService {
  protected readonly logger = new Logger(PermissionService.name);
  private roleHierarchyService?: RoleHierarchyService;
  private readonly permissionCache = new Map<string, CachedPermissions>();

  constructor(private readonly db: DatabaseAdapter) {}

  /** 注入角色层级服务（在模块初始化后调用） */
  setRoleHierarchyService(service: RoleHierarchyService): void {
    this.roleHierarchyService = service;
  }

  /**
   * Invalidate the permission cache for a specific user, or all users.
   * Call after role/permission changes to ensure fresh data.
   */
  invalidatePermissionCache(userId?: string): void {
    if (userId) {
      this.permissionCache.delete(userId);
    } else {
      this.permissionCache.clear();
    }
  }

  /**
   * 获取用户的所有权限（包括角色权限和直接权限）
   * Results are cached for a short TTL to avoid redundant DB queries
   * when multiple guards check permissions in the same request.
   */
  async findUserPermissions(userId: string): Promise<string[]> {
    const now = Date.now();
    const cached = this.permissionCache.get(userId);
    if (cached) {
      if (cached.expiresAt > now) {
        return cached.permissions;
      }
      // 过期条目立即删除
      this.permissionCache.delete(userId);
    }

    const permissions = await this._loadUserPermissions(userId);

    // Evict oldest if cache is full
    if (this.permissionCache.size >= PERMISSION_CACHE_MAX_SIZE) {
      const firstKey = this.permissionCache.keys().next().value!;
      this.permissionCache.delete(firstKey);
    }
    this.permissionCache.set(userId, {
      permissions,
      expiresAt: now + PERMISSION_CACHE_TTL_MS,
    });

    return permissions;
  }

  /**
   * Internal: load user permissions from database.
   */
  private async _loadUserPermissions(userId: string): Promise<string[]> {
    const finalPermissions = new Set<string>();

    const [userRoles, directUserPermissions] = await Promise.all([
      this.db
        .model('userRoles')
        .findMany({ where: { userId }, select: { roleId: true } }),
      this.db
        .model('userPermissions')
        .findMany({ where: { userId }, select: { permissionId: true } }),
    ]);

    const roleIds = (userRoles as Array<{ roleId: string }>).map(
      (ur) => ur.roleId,
    );

    // 角色层级展开：收集所有角色（包括父角色）
    // 批量获取所有角色的父角色，避免逐个查询
    const allRoleIds = new Set(roleIds);
    if (this.roleHierarchyService && roleIds.length > 0) {
      const parentResults = await Promise.all(
        roleIds.map((roleId) => this.roleHierarchyService!.getParentRoles(roleId)),
      );
      for (const parentIds of parentResults) {
        parentIds.forEach((id) => allRoleIds.add(id));
      }
    }
    const expandedRoleIds = Array.from(allRoleIds);

    if (expandedRoleIds.length > 0) {
      const roles = await this.db
        .model('roles')
        .findMany({
          where: { id: { in: expandedRoleIds } },
          select: { id: true, name: true },
        }) as Array<{ id: string; name: string }>;

      for (const role of roles) {
        if (role?.name) {
          finalPermissions.add(`role:${role.name}`);
          if (role.name === 'superadmin') {
            finalPermissions.add('*');
            finalPermissions.add('superadmin');
          }
        }
      }
    }

    const directPermissionIds = (directUserPermissions as Array<{ permissionId: string }>).map(
      (up) => up.permissionId,
    );
    const rolePermissionLinks =
      expandedRoleIds.length
        ? (await this.db.model('rolePermissions').findMany({
            where: { roleId: { in: expandedRoleIds } },
            select: { permissionId: true },
          })) as Array<{ permissionId: string }>
        : [] as Array<{ permissionId: string }>;
    const rolePermissionIds = rolePermissionLinks.map(
      (rp) => rp.permissionId,
    );

    const allPermissionIds = Array.from(
      new Set<string>([...directPermissionIds, ...rolePermissionIds]),
    );

    // 复合权限（resource:action）直接并入
    const compositeIds = allPermissionIds.filter((id) => id.includes(':'));
    compositeIds.forEach((id) => finalPermissions.add(id));

    // 资源级权限展开
    const resourceIds = allPermissionIds.filter((id) => !id.includes(':'));
    if (resourceIds.length > 0) {
      const permissionObjects = await this.db.model('permissions').findMany({
        where: { id: { in: resourceIds }, status: true },
      }) as Array<{ id: string; actions: unknown }>;
      for (const permission of permissionObjects) {
        this.addPermissionToSet(permission, finalPermissions);
      }
    }

    return Array.from(finalPermissions);
  }

  /**
   * 检查用户是否拥有所需权限
   */
  async hasPermission(
    userId: string,
    requiredPermissions: string[],
  ): Promise<boolean> {
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const userPermissions = await this.findUserPermissions(userId);
    if (
      userPermissions.includes('*') ||
      userPermissions.includes('superadmin')
    ) {
      return true;
    }

    for (const requiredPermission of requiredPermissions) {
      if (userPermissions.includes(requiredPermission)) {
        return true;
      }
      if (requiredPermission.includes('*')) {
        const prefix = requiredPermission.replace('*', '');
        if (userPermissions.some((p) => p.startsWith(prefix))) {
          return true;
        }
      }
      const [resource] = requiredPermission.split(':');
      if (userPermissions.includes(`${resource}:*`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查用户对特定数据的权限
   */
  async hasDataPermission(
    userId: string,
    dataType: string,
    dataId: string,
    action: string,
  ): Promise<boolean> {
    const userPermissions = await this.findUserPermissions(userId);
    if (
      userPermissions.includes('*') ||
      userPermissions.includes('superadmin')
    ) {
      return true;
    }

    const dataPermission = await this.db
      .model('userDataPermissions')
      .findUnique({
        where: {
          userId_dataType_dataId: { userId, dataType, dataId },
        },
      }) as { actions: string[] } | null;

    if (!dataPermission) {
      return false;
    }
    return dataPermission.actions.includes(action);
  }

  /**
   * 检查用户是否拥有指定维度（角色/部门等）
   *
   * 支持维度条件和角色条件校验。
   *
   * @param userId 用户 ID
   * @param dimensionType 维度类型，如 'role' 或 'department'
   * @param dimensionIds 需要的维度 ID 列表
   * @param logical AND = 全部满足, OR = 满足任一
   */
  async hasDimension(
    userId: string,
    dimensionType: string,
    dimensionIds: string[],
    logical: 'AND' | 'OR' | 'DEFAULT' = 'OR',
  ): Promise<boolean> {
    if (!dimensionIds || dimensionIds.length === 0) {
      return true;
    }

    // superadmin 检查
    const userPermissions = await this.findUserPermissions(userId);
    if (userPermissions.includes('*') || userPermissions.includes('superadmin')) {
      return true;
    }

    if (dimensionType === 'role') {
      const userRoles = (await this.db
        .model('userRoles')
        .findMany({ where: { userId }, select: { roleId: true } })) as Array<{ roleId: string }>;

      const roleIds = userRoles.map((ur) => ur.roleId);

      // 角色层级展开（批量并发）
      const allRoleIds = new Set(roleIds);
      if (this.roleHierarchyService && roleIds.length > 0) {
        const parentResults = await Promise.all(
          roleIds.map((roleId) => this.roleHierarchyService!.getParentRoles(roleId)),
        );
        for (const parentIds of parentResults) {
          parentIds.forEach((id) => allRoleIds.add(id));
        }
      }

      // 获取角色名称
      const expandedIds = Array.from(allRoleIds);
      const roles = expandedIds.length > 0
        ? (await this.db.model('roles').findMany({
            where: { id: { in: expandedIds } },
            select: { id: true, name: true },
          })) as Array<{ id: string; name: string }>
        : [];

      const userRoleSet = new Set<string>();
      for (const role of roles) {
        userRoleSet.add(role.id);
        if (role.name) userRoleSet.add(role.name);
      }

      if (logical === 'AND') {
        return dimensionIds.every((id) => userRoleSet.has(id));
      }
      return dimensionIds.some((id) => userRoleSet.has(id));
    }

    // Generic dimension check — look up user-dimension bindings
    const bindings = (await this.db
      .model('userDimensions')
      .findMany({
        where: { userId, dimensionType },
        select: { dimensionId: true },
      })) as Array<{ dimensionId: string }>;

    const userDimensionIds = new Set(bindings.map((b) => b.dimensionId));

    if (logical === 'AND') {
      return dimensionIds.every((id) => userDimensionIds.has(id));
    }
    return dimensionIds.some((id) => userDimensionIds.has(id));
  }

  /**
   * 检查用户是否拥有某资源的全部指定动作。
   */
  async hasResourceActions(
    userId: string,
    resourceId: string,
    actions: string[],
  ): Promise<boolean> {
    const userPermissions = await this.findUserPermissions(userId);

    if (userPermissions.includes('*') || userPermissions.includes('superadmin')) {
      return true;
    }

    if (userPermissions.includes(resourceId) || userPermissions.includes(`${resourceId}:*`)) {
      return true;
    }

    if (actions.length === 0) {
      return userPermissions.some((permission) => permission.startsWith(`${resourceId}:`));
    }

    return actions.every((action) => userPermissions.includes(`${resourceId}:${action}`));
  }

  /**
   * 批量导入权限
   */
  async importPermissions<T extends PermissionImportRecord>(
    permissions: T[], options: PermissionImportOptions<T> = {},
  ) {
    const results: Array<{ id: string; success: boolean; message: string }> = [];
    for (const permission of permissions) {
      try {
        const normalized: Record<string, unknown> = {};
        Object.assign(normalized, permission, {
          status: permission.status ?? true,
          actions: permission.actions ? JSON.parse(JSON.stringify(permission.actions)) : null,
          optionalFields: permission.optionalFields ? JSON.parse(JSON.stringify(permission.optionalFields)) : null,
          parents: permission.parents ? JSON.parse(JSON.stringify(permission.parents)) : null,
        });
        const data = options.mapData?.(permission, normalized) ?? { create: normalized, update: normalized };
        if (options.persist) {
          await options.persist(permission.id, data);
        } else {
          const model = this.db.model('permissions') as ReturnType<DatabaseAdapter['model']> & {
            upsert?: (args: Record<string, unknown>) => Promise<unknown>;
          };
          if (!model.upsert) throw new Error('Atomic permission upsert must be configured');
          await model.upsert({ where: { id: permission.id }, ...data });
        }
        results.push({ id: permission.id, success: true, message: options.successMessage ?? '权限同步成功' });
      } catch (error) {
        results.push({ id: permission.id, success: false,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.invalidatePermissionCache();
    const success = results.filter((item) => item.success).length;
    return { total: results.length, success, fail: results.length - success, results };
  }

  private addPermissionToSet(
    permission: { id: string; actions: unknown },
    permissions: Set<string>,
  ) {
    if (!Array.isArray(permission.actions)) return;
    for (const actionItem of permission.actions) {
      if (!actionItem) continue;
      if (typeof actionItem === 'string') {
        permissions.add(`${permission.id}:${actionItem}`);
        continue;
      }
      if (
        typeof actionItem === 'object' &&
        actionItem !== null &&
        'action' in actionItem
      ) {
        permissions.add(
          `${permission.id}:${(actionItem as { action: string }).action}`,
        );
      }
    }
  }
}
