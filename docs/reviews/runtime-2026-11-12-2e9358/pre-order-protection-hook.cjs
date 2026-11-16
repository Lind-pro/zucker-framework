const {CopyrightAdminUserHooks:FixedHooks}=require("/Users/lind/Documents/projects/zucker-ccopyright/apps/server/src/modules/back-office/copyright-admin-user-hooks.ts");
const {protectedRoleId}=require("@/modules/back-office/protected-role");
exports.CopyrightAdminUserHooks=class extends FixedHooks {async userRolesChanging(change,tx){const id=await protectedRoleId(tx);if(!id||change.roleIds.includes(id))return;return super.userRolesChanging(change,tx);}};
