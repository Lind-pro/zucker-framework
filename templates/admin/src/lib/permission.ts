import { createPermissionGuard, createUsePermission } from '@zucker-framework/fe-permission';
import useAuthStore from '../stores/useAuthStore';

export const usePermission = createUsePermission({ useAuthStore });
export const PermissionGuard = createPermissionGuard({ usePermission });
