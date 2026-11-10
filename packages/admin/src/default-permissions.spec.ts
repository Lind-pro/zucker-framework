// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotifyChannel, NotifyHistoryService, TemplateService } from '@zucker-framework/notification';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { DimensionUserService, PermissionService, PermissionsGuard, RoleHierarchyService, UserService } from '@zucker-framework/auth';
import { UsersController } from './users/users.controller';
import { RolesController } from './roles/roles.controller';
import { PermissionsController } from './permissions/permissions.controller';
import { DictionaryController } from './dictionary/dictionary.controller';
import { ConfigController } from './config/config.controller';
import { CreditController } from './credit/credit.controller';
import { LoggingController } from './logging/logging.controller';
import { NotificationController } from './notification/notification.controller';
import { FormController } from './form/form.controller';
import { I18nManagementController } from './i18n/i18n.controller';
import { TenantManagementController } from './tenant/tenant.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { HealthController } from './health/health.controller';

function context(controller: Type<unknown>, method: string, userId: string): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => Reflect.get(controller.prototype, method),
    switchToHttp: () => ({ getRequest: () => ({ user: { id: userId } }) }),
  } as unknown as ExecutionContext;
}

async function harness() {
  const db = new InMemoryAdapter();
  const permissions = new PermissionService(db);
  const hierarchy = new RoleHierarchyService(db);
  permissions.setRoleHierarchyService(hierarchy);
  const guard = new PermissionsGuard(new Reflector(), permissions);
  const users = new UsersController(new UserService(db), permissions, new DimensionUserService(db), db);
  const roles = new RolesController(hierarchy, db, permissions);
  for (const id of ['member', 'other', 'reader', 'editor', 'authorizer', 'role-editor', 'role-authorizer']) {
    await db.model('users').create({ data: { id, username: id, name: id, typeId: 'member', status: true } });
  }
  await db.model('roles').create({ data: { id: 'super-role', name: 'superadmin' } });
  await db.model('roles').create({ data: { id: 'normal-role', name: 'normal' } });
  const grant = async (userId: string, codes: string[]) => {
    for (const permissionId of codes) await db.model('userPermissions').create({ data: { userId, permissionId } });
    permissions.invalidatePermissionCache(userId);
  };
  await grant('reader', ['users:query']);
  await grant('editor', ['users:update']);
  await grant('authorizer', ['users:authorize']);
  await grant('role-editor', ['roles:add', 'roles:update']);
  await grant('role-authorizer', ['roles:add', 'roles:update', 'roles:authorize']);
  const invoke = async <T>(controller: Type<unknown>, method: string, actor: string, operation: () => Promise<T>) => {
    if (!await guard.canActivate(context(controller, method, actor))) throw new ForbiddenException();
    return operation();
  };
  return { db, permissions, guard, users, roles, grant, invoke };
}

const readRoutes: [Type<unknown>, string, string][] = [
  [UsersController, 'query', 'users'], [RolesController, 'query', 'roles'],
  [PermissionsController, 'query', 'permissions'], [DictionaryController, 'queryDictionaries', 'dictionary'],
  [ConfigController, 'getAll', 'config'], [CreditController, 'queryTransactions', 'credit'],
  [LoggingController, 'queryAccessLogs', 'logging'], [NotificationController, 'queryHistory', 'notification'],
  [FormController, 'queryDefinitions', 'form'], [I18nManagementController, 'query', 'i18n'],
  [TenantManagementController, 'query', 'tenant'], [DashboardController, 'getStats', 'dashboard'],
];

describe('default admin authorization boundaries', () => {
  it.each(readRoutes)('%s only permits its explicit query capability', async (controller, method, resource) => {
    const h = await harness();
    expect(await h.guard.canActivate(context(controller, method, 'member'))).toBe(false);
    await h.grant('member', [`${resource}:query`]);
    expect(await h.guard.canActivate(context(controller, method, 'member'))).toBe(true);
  });

  it('keeps public liveness outside the administrative permission requirement', async () => {
    const h = await harness();
    expect(await h.guard.canActivate(context(HealthController, 'check', 'member'))).toBe(true);
  });

  it('prevents a newly registered member from querying users, changing another user or binding superadmin', async () => {
    const h = await harness();
    await expect(h.invoke(UsersController, 'query', 'member', () => h.users.query({}))).rejects.toMatchObject({ status: 403 });
    await expect(h.invoke(UsersController, 'update', 'member', () => h.users.update('other', { name: 'changed' }))).rejects.toMatchObject({ status: 403 });
    await expect(h.invoke(UsersController, 'setUserRoles', 'member', () => h.users.setUserRoles('member', { roleIds: ['super-role'] }))).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('users').findUnique({ where: { id: 'other' } })).toMatchObject({ name: 'other' });
    expect(await h.db.model('userRoles').findMany({})).toEqual([]);
  });

  it('allows a query-only actor to read but not create, update, delete or authorize users', async () => {
    const h = await harness();
    expect(await h.invoke(UsersController, 'query', 'reader', () => h.users.query({}))).toMatchObject({ total: 7 });
    for (const method of ['create', 'update', 'remove', 'setUserRoles', 'setUserPermissions', 'setUserDimensions']) {
      expect(await h.guard.canActivate(context(UsersController, method, 'reader'))).toBe(false);
    }
  });

  it('keeps user editing and authorization separate and applies granted role changes immediately', async () => {
    const h = await harness();
    await h.invoke(UsersController, 'update', 'editor', () => h.users.update('other', { name: 'Allowed edit' }));
    for (const method of ['setUserRoles', 'setUserPermissions', 'setUserDimensions']) {
      expect(await h.guard.canActivate(context(UsersController, method, 'editor'))).toBe(false);
    }
    expect(await h.permissions.hasPermission('member', ['config:update'])).toBe(false);
    await h.invoke(UsersController, 'setUserRoles', 'authorizer', () => h.users.setUserRoles('member', { roleIds: ['super-role'] }));
    expect(await h.permissions.hasPermission('member', ['config:update'])).toBe(true);
    // The member now outranks the authorizer: only a superadmin may change it again.
    await expect(h.invoke(UsersController, 'setUserRoles', 'authorizer', () => h.users.setUserRoles('member', { roleIds: [] }, { user: { id: 'authorizer' } })))
      .rejects.toMatchObject({ status: 403 });
    await h.db.model('userRoles').create({ data: { userId: 'other', roleId: 'super-role' } });
    h.permissions.invalidatePermissionCache('other');
    await h.users.setUserRoles('member', { roleIds: [] }, { user: { id: 'other' } });
    expect(await h.permissions.hasPermission('member', ['config:update'])).toBe(false);
    expect(await h.guard.canActivate(context(UsersController, 'update', 'authorizer'))).toBe(false);
  });

  it('allows role metadata edits but rejects hidden grants, inherited grants and privileged renames', async () => {
    const h = await harness();
    const req = { user: { id: 'role-editor' } };
    await h.invoke(RolesController, 'create', 'role-editor', () => h.roles.create({ name: 'ordinary' }, req));
    await h.invoke(RolesController, 'update', 'role-editor', () => h.roles.update('normal-role', { description: 'Allowed metadata' }, req));
    for (const body of [{ permissionIds: ['users:delete'] }, { permissionIds: [] }, { parentId: 'super-role' }, { name: 'superadmin' }]) {
      await expect(h.invoke(RolesController, 'update', 'role-editor', () => h.roles.update('normal-role', body, req))).rejects.toMatchObject({ status: 403 });
    }
    await expect(h.invoke(RolesController, 'create', 'role-editor', () => h.roles.create({ name: 'superadmin' }, req))).rejects.toMatchObject({ status: 403 });
    await expect(h.invoke(RolesController, 'update', 'role-editor', () => h.roles.update('normal-role', {
      rolePermissions: { create: [{ permissionId: 'users:delete' }] },
    }, req))).rejects.toMatchObject({ status: 400 });
    expect(await h.db.model('roles').findUnique({ where: { id: 'normal-role' } })).toMatchObject({ name: 'normal', description: 'Allowed metadata' });
    expect(await h.db.model('rolePermissions').findMany({})).toEqual([]);
  });

  it('permits an explicitly authorized role editor to replace grants and invalidates cached access', async () => {
    const h = await harness();
    await h.db.model('userRoles').create({ data: { userId: 'member', roleId: 'normal-role' } });
    expect(await h.permissions.hasPermission('member', ['users:delete'])).toBe(false);
    await h.grant('reader', ['roles:authorize']);
    expect(await h.guard.canActivate(context(RolesController, 'create', 'reader'))).toBe(false);
    expect(await h.guard.canActivate(context(RolesController, 'update', 'reader'))).toBe(false);
    const req = { user: { id: 'role-authorizer' } };
    await h.invoke(RolesController, 'update', 'role-authorizer', () => h.roles.update('normal-role', { permissionIds: ['users:delete'] }, req));
    expect(await h.permissions.hasPermission('member', ['users:delete'])).toBe(true);
    await h.invoke(RolesController, 'update', 'role-authorizer', () => h.roles.update('normal-role', { permissionIds: [] }, req));
    expect(await h.permissions.hasPermission('member', ['users:delete'])).toBe(false);
  });

  it('cannot use template creation to overwrite an existing notification without update permission', async () => {
    const h = await harness();
    const templates = new TemplateService();
    const controller = new NotificationController(templates, new NotifyHistoryService());
    const definition = { id: 'notice', name: 'Notice', channel: NotifyChannel.EMAIL, content: 'Original' };
    await h.grant('reader', ['notification:add']);
    await h.invoke(NotificationController, 'createTemplate', 'reader', async () => controller.createTemplate(definition));
    await expect(h.invoke(NotificationController, 'createTemplate', 'reader', async () => controller.createTemplate({ ...definition, content: 'Overwritten' }))).rejects.toMatchObject({ status: 409 });
    expect(templates.getTemplate('notice')?.content).toBe('Original');
    expect(await h.guard.canActivate(context(NotificationController, 'updateTemplate', 'reader'))).toBe(false);
    await h.grant('reader', ['notification:update']);
    await h.invoke(NotificationController, 'updateTemplate', 'reader', async () => controller.updateTemplate('notice', { content: 'Allowed update' }));
    expect(templates.getTemplate('notice')?.content).toBe('Allowed update');
  });

  it('does not allow read capabilities to reach writes in any default controller', async () => {
    const h = await harness();
    const mutations: [Type<unknown>, string, string, string][] = [
      [RolesController, 'create', 'roles', 'add'], [RolesController, 'remove', 'roles', 'delete'],
      [PermissionsController, 'create', 'permissions', 'add'], [PermissionsController, 'update', 'permissions', 'update'],
      [PermissionsController, 'remove', 'permissions', 'delete'], [PermissionsController, 'syncPermissions', 'permissions', 'update'],
      [DictionaryController, 'createDictionary', 'dictionary', 'add'], [DictionaryController, 'createDictionaryItem', 'dictionary', 'add'],
      [DictionaryController, 'updateDictionary', 'dictionary', 'update'], [DictionaryController, 'updateDictionaryItem', 'dictionary', 'update'],
      [DictionaryController, 'deleteDictionary', 'dictionary', 'delete'], [DictionaryController, 'deleteDictionaryItem', 'dictionary', 'delete'],
      [ConfigController, 'setAll', 'config', 'update'], [NotificationController, 'createTemplate', 'notification', 'add'],
      [NotificationController, 'updateTemplate', 'notification', 'update'], [NotificationController, 'removeTemplate', 'notification', 'delete'],
      [FormController, 'create', 'form', 'add'], [FormController, 'update', 'form', 'update'], [FormController, 'remove', 'form', 'delete'],
      [I18nManagementController, 'create', 'i18n', 'add'], [I18nManagementController, 'update', 'i18n', 'update'],
      [TenantManagementController, 'create', 'tenant', 'add'], [TenantManagementController, 'update', 'tenant', 'update'],
      [TenantManagementController, 'remove', 'tenant', 'delete'],
    ];
    for (const [controller, method, resource, action] of mutations) {
      const actor = `${resource}-${method}`;
      await h.grant(actor, [`${resource}:query`]);
      expect(await h.guard.canActivate(context(controller, method, actor))).toBe(false);
      await h.grant(actor, [`${resource}:${action}`]);
      expect(await h.guard.canActivate(context(controller, method, actor))).toBe(true);
    }
  });
});
