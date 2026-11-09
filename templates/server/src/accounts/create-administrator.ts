import type { DatabaseAdapter } from '@zucker-framework/core';
import { UsernameValidator, UserService } from '@zucker-framework/auth';

import type { SubscriptionPlanWrite } from '@zucker-framework/payment';
import { seedPlans } from '../subscriptions/plan-seeds';
import { starterAdminMenus } from './starter-admin-menus';

/**
 * Back-office permission codes (RFC §8) that are checked with `@Permissions(code)` rather than
 * discovered from `@Resource` declarations, so they must exist as rows before an administrator can
 * grant them to a delegated role. Together with every starter menu code they are seeded once.
 * Installations created before these codes existed get them (and the new starter menus) from the
 * idempotent data step of migration 20261109000000_back_office; keep both lists in sync.
 */
export const BACK_OFFICE_PERMISSIONS: readonly string[] = [
  'plans:query', 'plans:add', 'plans:update', 'plans:delete',
  'subscriptions:query', 'subscriptions:update',
  'quota:query', 'quota:update',
  'mail:query', 'mail:update',
];

/** Explicit owner setup only. This function is never reachable from public account HTTP routes. */
export async function createAdministrator(
  db: DatabaseAdapter,
  input: { username: string; email: string; password: string },
  /** Initial plans (see planSeedsFromBillingCatalog); existing slugs are never changed. */
  options: { plans?: readonly SubscriptionPlanWrite[] } = {},
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('Invalid administrator email');
  return db.$transaction(async (tx) => {
    const users = new UserService(tx);
    // Reserved public account names may be used only by this explicit owner command.
    users.setUsernameValidator(new UsernameValidator({ reservedNames: [] }));
    if (await users.findByUsername(input.username))
      throw new Error(
        'Account already exists; existing accounts are never promoted or overwritten',
      );
    const user = await users.addUser({
      username: input.username,
      password: input.password,
      email,
      name: input.username,
      typeId: 'administrator',
      status: true,
      emailVerified: true,
    });
    const role = ((await tx.model('roles').findUnique({ where: { name: 'superadmin' } })) ??
      (await tx
        .model('roles')
        .create({ data: { name: 'superadmin', description: 'Administrator' } }))) as { id: string };
    await tx.model('userRoles').create({ data: { userId: user.id, roleId: role.id } });
    for (const [sortOrder, menu] of starterAdminMenus.entries()) {
      const { key, name, path, parent, permission } = menu;
      const id = `starter:${key}`;
      if (!(await tx.model('menus').findUnique({ where: { id } }))) {
        await tx
          .model('menus')
          .create({
            data: {
              id,
              name,
              ...(path ? { path } : {}),
              ...(parent ? { parentId: `starter:${parent}` } : {}),
              permissions: permission ? [permission] : [],
              sortOrder,
              status: true,
            },
          });
      }
    }
    const codes = new Set([...BACK_OFFICE_PERMISSIONS, ...starterAdminMenus.flatMap(menu => menu.permission ? [menu.permission] : [])]);
    for (const code of codes)
      if (!(await tx.model('permissions').findUnique({ where: { id: code } })))
        await tx.model('permissions').create({ data: { id: code, name: code, description: 'Seeded with the starter back office' } });
    await seedPlans(tx, options.plans ?? []);
    return user.id;
  });
}
