import React, { ReactNode } from 'react';

export interface PermissionGuardProps {
  permission?: string;
  anyPermissions?: string[];
  allPermissions?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}

export interface PermissionGuardConfig {
  usePermission: () => {
    hasPermission: (code: string) => boolean;
    hasAnyPermission: (codes: string[]) => boolean;
    hasAllPermissions: (codes: string[]) => boolean;
    getAllPermissions: () => string[];
  };
}

export function createPermissionGuard(config: PermissionGuardConfig) {
  const { usePermission } = config;

  return function PermissionGuard({
    permission,
    anyPermissions,
    allPermissions,
    fallback = null,
    children,
  }: PermissionGuardProps) {
    const {
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      getAllPermissions,
    } = usePermission();

    const permissions = getAllPermissions();

    const isSuperAdmin =
      permissions.includes('*') ||
      permissions.includes('superadmin') ||
      permissions.includes('admin');

    if (isSuperAdmin) {
      return <>{children}</>;
    }

    let hasAccess = true;

    if (permission) {
      hasAccess = hasPermission(permission);
    }

    if (anyPermissions && anyPermissions.length > 0) {
      hasAccess = hasAccess && hasAnyPermission(anyPermissions);
    }

    if (allPermissions && allPermissions.length > 0) {
      hasAccess = hasAccess && hasAllPermissions(allPermissions);
    }

    return <>{hasAccess ? children : fallback}</>;
  };
}
