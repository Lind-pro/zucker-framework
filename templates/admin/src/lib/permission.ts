import { createUsePermission } from '@zucker/fe-permission';
import { createPermissionGuard } from '@zucker/fe-permission';
import useAuthStore from '../stores/useAuthStore';

export const usePermission = createUsePermission({ useAuthStore });
export const PermissionGuard = createPermissionGuard({ usePermission });
