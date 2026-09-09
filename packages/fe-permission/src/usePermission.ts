import { useCallback } from 'react';
import type { AuthStore } from '@zucker-framework/fe-auth';

/** Configuration for the permission hook factory, requiring an auth store selector. */
export interface UsePermissionConfig {
  useAuthStore: <T>(selector: (state: AuthStore) => T) => T;
}

/** Create a React hook for checking user permissions against the auth store. */
export function createUsePermission(config: UsePermissionConfig) {
  return function usePermission() {
    const { useAuthStore } = config;
    const permissions = useAuthStore((state) => state.permissions);

    const hasPermission = useCallback(
      (permissionCode: string): boolean => {
        if (!permissions || permissions.length === 0) return false;
        if (permissions.some((p: string) => p === '*' || p === 'superadmin')) return true;

        return permissions.some((p: string) => {
          if (p === permissionCode) return true;
          const [resource, action] = permissionCode.split(':');
          if (resource && action && p === `${resource}:*`) return true;
          if (resource && action && p === `${resource}.${action}`) return true;
          return false;
        });
      },
      [permissions],
    );

    const hasAnyPermission = useCallback(
      (permissionCodes: string[]): boolean => {
        if (permissions.some((p: string) => p === '*' || p === 'superadmin')) return true;
        return permissionCodes.some((code) => hasPermission(code));
      },
      [hasPermission, permissions],
    );

    const hasAllPermissions = useCallback(
      (permissionCodes: string[]): boolean => {
        if (permissions.some((p: string) => p === '*' || p === 'superadmin')) return true;
        return permissionCodes.every((code) => hasPermission(code));
      },
      [hasPermission, permissions],
    );

    const getAllPermissions = useCallback(() => {
      return permissions || [];
    }, [permissions]);

    return { hasPermission, hasAnyPermission, hasAllPermissions, getAllPermissions };
  };
}
