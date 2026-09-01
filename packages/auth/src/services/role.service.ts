import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, NotFoundException, BusinessException } from '@zucker/core';
import { DATABASE_ADAPTER } from '@zucker/crud';
import { PermissionService } from './permission.service';
import type { RoleHierarchyService } from './role-hierarchy.service';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

/** Role entity shape — 对齐 Prisma schema `model roles` */
export interface RoleEntity {
  id: string;
  name: string;
  description?: string;
  status?: boolean;
  parentId?: string;
  groupId?: string;
  creatorId?: string;
  createTime?: Date | number;
  [key: string]: unknown;
}

/** Role event topics — mirrors hsweb authorization role event topics */
export const ROLE_EVENT_TOPICS = {
  ROLE_CREATED: '/role/created',
  ROLE_MODIFIED: '/role/modified',
  ROLE_DELETED: '/role/deleted',
} as const;

export function createRoleCreatedEvent(roleId: string, roleName: string, creatorId?: string) {
  return { roleId, roleName, creatorId, timestamp: Date.now() };
}

export function createRoleModifiedEvent(roleId: string, changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>) {
  return { roleId, changes, timestamp: Date.now() };
}

export function createRoleDeletedEvent(roleId: string) {
  return { roleId, timestamp: Date.now() };
}

/**
 * RoleService -- corresponds to hsweb DefaultRoleService.
 *
 * Provides complete role lifecycle management:
 * - CRUD operations with name-based lookup
 * - Permission assignment with transactional guarantee
 * - Cascade deletion of related rolePermissions/userRoles/roleMenus
 * - Event publishing for all role mutations
 *
 * Reference: hsweb-system-authorization DefaultRoleService
 */
@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  private roleHierarchyService?: RoleHierarchyService;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly topicEventBus?: TopicEventBusLike,
    @Optional() private readonly permissionService?: PermissionService,
  ) {}

  /** 注入角色层级服务（在模块初始化后调用） */
  setRoleHierarchyService(service: RoleHierarchyService): void {
    this.roleHierarchyService = service;
  }

  /**
   * Find a role by ID.
   *
   * Reference: hsweb DefaultRoleService.findById()
   */
  async findById(id: string): Promise<RoleEntity | null> {
    return this.db.model('roles').findUnique({ where: { id } }) as Promise<RoleEntity | null>;
  }

  /**
   * Find a role by name.
   *
   * Reference: hsweb DefaultRoleService.findByName()
   */
  async findByName(name: string): Promise<RoleEntity | null> {
    if (!name) return null;
    const roles = (await this.db.model('roles').findMany({
      where: { name },
    })) as RoleEntity[];
    return roles[0] ?? null;
  }

  /**
   * Query roles with dynamic filters.
   *
   * Reference: hsweb DefaultRoleService.findRoles()
   */
  async findRoles(where?: Record<string, unknown>): Promise<RoleEntity[]> {
    return this.db.model('roles').findMany({
      where: where ?? {},
    }) as Promise<RoleEntity[]>;
  }

  /**
   * Count roles matching a filter.
   *
   * Reference: hsweb DefaultRoleService.countRoles()
   */
  async countRoles(where?: Record<string, unknown>): Promise<number> {
    const roles = (await this.db.model('roles').findMany({
      where: where ?? {},
      select: { id: true },
    })) as Array<{ id: string }>;
    return roles.length;
  }

  /**
   * Add a new role.
   *
   * Reference: hsweb DefaultRoleService.doAdd()
   * - Sets default status and createTime
   * - Publishes RoleCreatedEvent
   */
  async addRole(
    data: Partial<RoleEntity> & { name: string },
  ): Promise<RoleEntity> {
    const existing = await this.findByName(data.name);
    if (existing) {
      throw new BusinessException(`角色名 "${data.name}" 已存在`, 'ROLE_NAME_DUPLICATE', 409);
    }

    const roleEntity: Record<string, unknown> = {
      ...data,
      status: data.status ?? true,
      createTime: data.createTime ? new Date(data.createTime as number) : new Date(),
    };

    const created = (await this.db.model('roles').create({
      data: roleEntity,
    })) as RoleEntity;

    // Publish RoleCreatedEvent
    await this.publishEvent(
      ROLE_EVENT_TOPICS.ROLE_CREATED,
      createRoleCreatedEvent(created.id, created.name, data.creatorId),
    );

    return created;
  }

  /**
   * Update an existing role.
   *
   * Reference: hsweb DefaultRoleService.doUpdate()
   * - Tracks field changes
   * - Publishes RoleModifiedEvent
   */
  async updateRole(
    id: string,
    data: Partial<RoleEntity>,
  ): Promise<RoleEntity> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (data.name && data.name !== existing.name) {
      const conflict = await this.findByName(data.name);
      if (conflict) {
        throw new BusinessException(`角色名 "${data.name}" 已被使用`, 'ROLE_NAME_DUPLICATE', 409);
      }
    }

    // Track field changes
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    for (const [key, value] of Object.entries(data)) {
      if (key === 'id') continue;
      if (existing[key] !== value && value !== undefined) {
        changes.push({ field: key, oldValue: existing[key], newValue: value });
      }
    }

    const updateData = { ...data };
    delete updateData.id;

    await this.db.model('roles').update({
      where: { id },
      data: updateData,
    });

    const updated = { ...existing, ...updateData } as RoleEntity;

    // parentId 变更时清除角色层级缓存
    if (data.parentId !== undefined && data.parentId !== existing.parentId) {
      this.roleHierarchyService?.invalidateCache();
      this.permissionService?.invalidatePermissionCache();
    }

    // Publish RoleModifiedEvent
    await this.publishEvent(
      ROLE_EVENT_TOPICS.ROLE_MODIFIED,
      createRoleModifiedEvent(id, changes),
    );

    return updated;
  }

  /**
   * Delete a role with cascade cleanup.
   *
   * Reference: hsweb DefaultRoleService.deleteRole()
   * - Cascade deletes rolePermissions, userRoles, roleMenus
   * - Publishes RoleDeletedEvent
   */
  async deleteRole(id: string): Promise<boolean> {
    const role = await this.findById(id);
    if (!role) return false;

    // Cascade delete related records in a transaction
    await this.db.$transaction(async (tx: DatabaseAdapter) => {
      await tx.model('rolePermissions').deleteMany({ where: { roleId: id } });
      await tx.model('userRoles').deleteMany({ where: { roleId: id } });
      await tx.model('roleMenus').deleteMany({ where: { roleId: id } });
      await tx.model('roles').delete({ where: { id } });
    });

    // 角色删除后清除所有权限和层级缓存
    this.roleHierarchyService?.invalidateCache();
    this.permissionService?.invalidatePermissionCache();

    // Publish RoleDeletedEvent
    await this.publishEvent(
      ROLE_EVENT_TOPICS.ROLE_DELETED,
      createRoleDeletedEvent(id),
    );

    return true;
  }

  /**
   * Get permission IDs assigned to a role.
   *
   * Reference: hsweb DefaultRoleService.getRolePermissions()
   */
  async getRolePermissions(roleId: string): Promise<string[]> {
    const links = (await this.db.model('rolePermissions').findMany({
      where: { roleId },
      select: { permissionId: true },
    })) as Array<{ permissionId: string }>;

    return links.map((l) => l.permissionId);
  }

  /**
   * Set permissions for a role (replace all).
   * Uses transaction to ensure atomicity.
   *
   * Reference: hsweb DefaultRoleService.setRolePermissions()
   */
  async setRolePermissions(roleId: string, permissionIds: string[]): Promise<void> {
    const role = await this.findById(roleId);
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    await this.db.$transaction(async (tx: DatabaseAdapter) => {
      await tx.model('rolePermissions').deleteMany({ where: { roleId } });
      const uniqueIds = Array.from(new Set(permissionIds));
      for (const permissionId of uniqueIds) {
        await tx.model('rolePermissions').create({
          data: { roleId, permissionId },
        });
      }
    });

    // 角色权限变更后清除所有权限缓存（影响该角色关联的所有用户）
    this.permissionService?.invalidatePermissionCache();
  }

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      try {
        await this.topicEventBus.publish(topic, payload);
      } catch (err) {
        this.logger.warn(`Failed to publish event ${topic}: ${err}`);
      }
    }
  }
}
