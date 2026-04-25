import { Injectable, Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker/core';

export interface MenuNode {
  id: string;
  name: string;
  path?: string;
  icon?: string;
  parentId?: string;
  sortOrder: number;
  status: boolean;
  permissions: string[];
  properties?: Record<string, unknown>;
  children?: MenuNode[];
}

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);

  constructor(private readonly db: DatabaseAdapter) {}

  /** 获取完整菜单树 */
  async getMenuTree(): Promise<MenuNode[]> {
    const menus = await this.db.model('menus').findMany({
      where: { status: true },
      orderBy: [{ sortOrder: 'asc' }],
    });

    return this.buildTree(menus as MenuNode[]);
  }

  /** 根据用户权限过滤菜单树 */
  async getMenuTreeByUserId(
    userId: string,
    userPermissions: string[],
  ): Promise<MenuNode[]> {
    const allMenus = await this.db.model('menus').findMany({
      where: { status: true },
      orderBy: [{ sortOrder: 'asc' }],
    });

    const isSuperAdmin =
      userPermissions.includes('*') ||
      userPermissions.includes('superadmin');

    // 获取用户角色关联的菜单
    const userRoles = await this.db.model('userRoles').findMany({
      where: { userId },
      select: { roleId: true },
    });
    const roleIds = (userRoles as Array<{ roleId: string }>).map(
      (ur) => ur.roleId,
    );

    let roleMenuIds: Set<string> = new Set();
    if (roleIds.length > 0) {
      const roleMenus = await this.db.model('roleMenus').findMany({
        where: { roleId: { in: roleIds } },
        select: { menuId: true },
      });
      roleMenuIds = new Set(
        (roleMenus as Array<{ menuId: string }>).map((rm) => rm.menuId),
      );
    }

    // 过滤菜单：超级管理员看全部，否则按权限和角色菜单关联过滤
    const filteredMenus = (allMenus as MenuNode[]).filter((menu) => {
      if (isSuperAdmin) return true;

      // 如果菜单通过角色关联
      if (roleMenuIds.has(menu.id)) return true;

      // 如果菜单没有权限要求，默认可见
      if (!menu.permissions || menu.permissions.length === 0) return true;

      // 检查用户是否拥有菜单所需的任一权限
      return menu.permissions.some((perm) =>
        userPermissions.includes(perm),
      );
    });

    // 构建树时确保父节点也被包含
    const filteredIds = new Set(filteredMenus.map((m) => m.id));
    const allMenuMap = new Map(
      (allMenus as MenuNode[]).map((m) => [m.id, m]),
    );

    // 向上追溯确保所有父节点存在
    for (const menu of filteredMenus) {
      let parentId = menu.parentId;
      while (parentId && !filteredIds.has(parentId)) {
        const parent = allMenuMap.get(parentId);
        if (parent) {
          filteredIds.add(parentId);
          filteredMenus.push(parent);
          parentId = parent.parentId;
        } else {
          break;
        }
      }
    }

    return this.buildTree(filteredMenus);
  }

  /** 根据角色获取菜单 ID 列表 */
  async getMenuIdsByRoleId(roleId: string): Promise<string[]> {
    const roleMenus = await this.db.model('roleMenus').findMany({
      where: { roleId },
      select: { menuId: true },
    });
    return (roleMenus as Array<{ menuId: string }>).map((rm) => rm.menuId);
  }

  /** 为角色分配菜单 */
  async assignMenusToRole(
    roleId: string,
    menuIds: string[],
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // 先删除现有关联
      await tx.model('roleMenus').deleteMany({ where: { roleId } });

      // 批量创建新关联
      if (menuIds.length > 0) {
        await tx.model('roleMenus').createMany({
          data: menuIds.map((menuId) => ({ roleId, menuId })),
        });
      }
    });
  }

  /**
   * 批量更新菜单（排序、状态等）
   * 对标 hsweb MenuService.batchUpdate()
   */
  async batchUpdate(
    menus: Array<{ id: string; sortOrder?: number; status?: boolean; name?: string; path?: string; icon?: string }>,
  ): Promise<number> {
    let updated = 0;
    for (const menu of menus) {
      const { id, ...data } = menu;
      if (Object.keys(data).length === 0) continue;
      try {
        await this.db.model('menus').update({ where: { id }, data });
        updated++;
      } catch {
        this.logger.warn(`Menu ${id} update skipped (not found)`);
      }
    }
    return updated;
  }

  private buildTree(
    nodes: MenuNode[],
    parentId: string | null = null,
    visited: Set<string> = new Set(),
  ): MenuNode[] {
    const result: MenuNode[] = [];

    for (const node of nodes) {
      if (visited.has(node.id)) continue; // 循环检测
      const nodeParentId = node.parentId ?? null;
      if (nodeParentId === parentId) {
        const newVisited = new Set(visited);
        newVisited.add(node.id);
        const children = this.buildTree(nodes, node.id, newVisited);
        const menuNode: MenuNode = { ...node };
        if (children.length > 0) {
          menuNode.children = children;
        }
        result.push(menuNode);
      }
    }

    return result;
  }
}
