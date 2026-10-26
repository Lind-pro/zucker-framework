import type { DatabaseAdapter } from '@zucker-framework/core';
import { UsernameValidator, UserService } from '@zucker-framework/auth';

import { starterAdminMenus } from './starter-admin-menus';

/** Explicit owner setup only. This function is never reachable from public account HTTP routes. */
export async function createAdministrator(
  db: DatabaseAdapter,
  input: { username: string; email: string; password: string },
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
    return user.id;
  });
}
