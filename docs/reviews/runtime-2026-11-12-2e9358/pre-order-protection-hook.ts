import { CopyrightAdminUserHooks as FixedHooks } from "/Users/lind/Documents/projects/zucker-ccopyright/apps/server/src/modules/back-office/copyright-admin-user-hooks.ts";
import { protectedRoleId } from '@/modules/back-office/protected-role';
import type { DatabaseAdapter } from '@zucker-framework/core';
export class CopyrightAdminUserHooks extends FixedHooks { async userRolesChanging(change:{userId:string;roleIds:readonly string[]},tx:DatabaseAdapter):Promise<void>{const id=await protectedRoleId(tx);if(!id||change.roleIds.includes(id))return;return super.userRolesChanging(change,tx);} }
