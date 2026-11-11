import { Injectable, Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { Permission, RoleTreeNode } from '../interfaces';
import {
  activeUserRoleSelect,
  activeUserRoleWhere,
  resolveRoleAssignmentOptions,
  type ResolvedRoleAssignmentOptions,
  type RoleAssignmentOptions,
} from './role-assignments';

@Injectable()
export class RoleHierarchyService {
  private readonly logger = new Logger(RoleHierarchyService.name);

  /**
   * Cached parent-ID lookup table: roleId -> parentId | undefined.
   * Populated lazily on first hierarchy traversal, cleared on invalidate().
   * Avoids N+1 DB queries when walking the role tree.
   */
  private parentIdMap: Map<string, string | undefined> | null = null;
  private parentIdMapLoadedAt = 0;

  /**
   * @param cacheTtlMs Upper bound on how long a hierarchy change made elsewhere (another
   *   instance, direct SQL) stays invisible. Local RoleService changes invalidate immediately.
   */
  constructor(private readonly db: DatabaseAdapter, private readonly cacheTtlMs = 60_000) {}

  private roleAssignments: ResolvedRoleAssignmentOptions = resolveRoleAssignmentOptions(undefined);

  /** Enable opt-in role expiry for user-role reads (see `role-assignments.ts`). */
  configureRoleAssignments(options: RoleAssignmentOptions | ResolvedRoleAssignmentOptions | undefined): void {
    this.roleAssignments = resolveRoleAssignmentOptions(options);
  }

  /**
   * Invalidate the cached role hierarchy.
   * Call after role CRUD operations that change parentId relationships.
   */
  invalidateCache(): void {
    this.parentIdMap = null;
  }

  /**
   * Load all role parentId mappings in a single query (lazy, cached).
   */
  private async ensureParentIdMap(): Promise<Map<string, string | undefined>> {
    if (this.parentIdMap && Date.now() - this.parentIdMapLoadedAt < this.cacheTtlMs) return this.parentIdMap;
    const allRoles = await this.db.model('roles').findMany({
      select: { id: true, parentId: true },
    }) as Array<{ id: string; parentId?: string }>;
    const map = new Map(allRoles.map((r) => [r.id, r.parentId]));
    this.parentIdMap = map;
    this.parentIdMapLoadedAt = Date.now();
    return map;
  }

  /**
   * 获取角色的所有父角色（递归向上）
   * Uses cached parent-ID map to avoid N+1 DB queries.
   */
  async getParentRoles(roleId: string): Promise<string[]> {
    const parentMap = await this.ensureParentIdMap();
    const visited = new Set<string>();
    let current = roleId;
    while (current) {
      if (visited.has(current)) break; // cycle protection
      visited.add(current);
      const parentId = parentMap.get(current);
      if (!parentId) break;
      current = parentId;
    }
    visited.delete(roleId);
    return Array.from(visited);
  }

  /**
   * 获取角色的所有子角色（递归向下）
   * Uses cached parent-ID map to build child lookup in-memory.
   */
  async getChildRoles(roleId: string): Promise<string[]> {
    const parentMap = await this.ensureParentIdMap();
    // Build children lookup from parent map
    const childrenMap = new Map<string, string[]>();
    for (const [id, parentId] of parentMap) {
      if (parentId) {
        const children = childrenMap.get(parentId) ?? [];
        children.push(id);
        childrenMap.set(parentId, children);
      }
    }
    const visited = new Set<string>();
    const stack = [roleId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = childrenMap.get(current);
      if (children) stack.push(...children);
    }
    visited.delete(roleId);
    return Array.from(visited);
  }

  /**
   * 获取角色的完整权限集（包括继承自父角色的权限）
   * 递归展开角色层级，合并所有权限
   */
  async getRolePermissions(roleId: string): Promise<Permission[]> {
    // 收集自身和所有父角色
    const allRoleIds = [roleId, ...(await this.getParentRoles(roleId))];
    return this.loadPermissionsByRoleIds(allRoleIds);
  }

  /**
   * 获取角色的所有权限（包括继承自父角色的）
   * 同 getRolePermissions，保持向后兼容
   */
  async getExpandedPermissions(roleId: string): Promise<Permission[]> {
    return this.getRolePermissions(roleId);
  }

  /**
   * 获取角色树
   */
  async getRoleTree(): Promise<RoleTreeNode[]> {
    return this.buildRoleTree();
  }

  /**
   * 构建角色树
   */
  async buildRoleTree(): Promise<RoleTreeNode[]> {
    const allRoles = await this.db.model('roles').findMany({}) as Array<{
      id: string;
      name: string;
      parentId?: string;
    }>;

    const rolePermissions = await this.loadRolePermissions(
      allRoles.map((r) => r.id),
    );

    const nodeMap = new Map<string, RoleTreeNode>();
    for (const role of allRoles) {
      nodeMap.set(role.id, {
        id: role.id,
        name: role.name,
        parentId: role.parentId,
        permissions: rolePermissions.get(role.id) || [],
        children: [],
      });
    }

    const roots: RoleTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * 获取用户通过角色层级展开后的所有权限 ID
   */
  async getUserExpandedPermissionIds(userId: string): Promise<string[]> {
    const userRoles = await this.db
      .model('userRoles')
      .findMany({
        where: activeUserRoleWhere(userId, this.roleAssignments, new Date()),
        select: activeUserRoleSelect(this.roleAssignments),
      }) as Array<{ roleId: string }>;

    if (userRoles.length === 0) return [];

    // 对每个角色递归展开
    const allRoleIds = new Set<string>();
    for (const { roleId } of userRoles) {
      allRoleIds.add(roleId);
      const parentIds = await this.getParentRoles(roleId);
      parentIds.forEach((id) => allRoleIds.add(id));
    }

    const permissions = await this.loadPermissionsByRoleIds(
      Array.from(allRoleIds),
    );

    return permissions.map((p) => p.id);
  }

  private async loadPermissionsByRoleIds(
    roleIds: string[],
  ): Promise<Permission[]> {
    if (roleIds.length === 0) return [];

    const links = await this.db
      .model('rolePermissions')
      .findMany({
        where: { roleId: { in: roleIds } },
        select: { permissionId: true },
      }) as Array<{ permissionId: string }>;

    const permissionIds = [
      ...new Set(links.map((l) => l.permissionId)),
    ];

    if (permissionIds.length === 0) return [];

    return this.db.model('permissions').findMany({
      where: { id: { in: permissionIds } },
    }) as Promise<Permission[]>;
  }

  private async loadRolePermissions(
    roleIds: string[],
  ): Promise<Map<string, Permission[]>> {
    if (roleIds.length === 0) return new Map();

    const links =
      await this.db.model('rolePermissions').findMany({
        where: { roleId: { in: roleIds } },
        select: { roleId: true, permissionId: true },
      }) as Array<{ roleId: string; permissionId: string }>;

    const permissionIds = [
      ...new Set(links.map((l) => l.permissionId)),
    ];
    const permissions =
      permissionIds.length > 0
        ? await this.db
            .model('permissions')
            .findMany({ where: { id: { in: permissionIds } } }) as Permission[]
        : [] as Permission[];

    const permMap = new Map<string, Permission>();
    for (const p of permissions) {
      permMap.set(p.id, p);
    }

    const result = new Map<string, Permission[]>();
    for (const link of links) {
      const perm = permMap.get(link.permissionId);
      if (!perm) continue;
      const list = result.get(link.roleId) || [];
      list.push(perm);
      result.set(link.roleId, list);
    }

    return result;
  }
}
