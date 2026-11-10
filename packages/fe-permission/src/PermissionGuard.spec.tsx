import React from 'react';
import { render } from '@testing-library/react';
import { createPermissionGuard } from './PermissionGuard';

function createGuardWithPermissions(permissions: string[]) {
  const usePermission = () => ({
    hasPermission: (code: string) => permissions.includes(code),
    hasAnyPermission: (codes: string[]) => codes.some((c) => permissions.includes(c)),
    hasAllPermissions: (codes: string[]) => codes.every((c) => permissions.includes(c)),
    getAllPermissions: () => permissions,
  });

  return createPermissionGuard({ usePermission });
}

describe('PermissionGuard', () => {
  it('should render children when user has the required permission', () => {
    const Guard = createGuardWithPermissions(['user:read']);
    const { getByText } = render(
      <Guard permission="user:read"><span>Allowed</span></Guard>,
    );
    expect(getByText('Allowed')).toBeTruthy();
  });

  it('should render fallback when permission is missing', () => {
    const Guard = createGuardWithPermissions(['user:read']);
    const { getByText, queryByText } = render(
      <Guard permission="user:delete" fallback={<span>Denied</span>}>
        <span>Allowed</span>
      </Guard>,
    );
    expect(queryByText('Allowed')).toBeNull();
    expect(getByText('Denied')).toBeTruthy();
  });

  it('should always grant access to superadmin', () => {
    const Guard = createGuardWithPermissions(['superadmin']);
    const { getByText } = render(
      <Guard permission="any:permission"><span>Admin</span></Guard>,
    );
    expect(getByText('Admin')).toBeTruthy();
  });

  it('does not treat a plain "admin" permission as super-admin (matches usePermission)', () => {
    const Guard = createGuardWithPermissions(['admin']);
    const { queryByText } = render(
      <Guard permission="some:perm"><span>Admin</span></Guard>,
    );
    expect(queryByText('Admin')).toBeNull();
  });

  it('should always grant access to wildcard *', () => {
    const Guard = createGuardWithPermissions(['*']);
    const { getByText } = render(
      <Guard permission="anything"><span>Star</span></Guard>,
    );
    expect(getByText('Star')).toBeTruthy();
  });

  it('should check anyPermissions', () => {
    const Guard = createGuardWithPermissions(['post:read']);
    const { getByText } = render(
      <Guard anyPermissions={['user:read', 'post:read']}>
        <span>OK</span>
      </Guard>,
    );
    expect(getByText('OK')).toBeTruthy();
  });

  it('should check allPermissions', () => {
    const Guard = createGuardWithPermissions(['a', 'b']);
    const { queryByText } = render(
      <Guard allPermissions={['a', 'b', 'c']} fallback={<span>No</span>}>
        <span>Yes</span>
      </Guard>,
    );
    expect(queryByText('Yes')).toBeNull();
  });

  it('should render null as default fallback', () => {
    const Guard = createGuardWithPermissions([]);
    const { container } = render(
      <Guard permission="x"><span>Hidden</span></Guard>,
    );
    expect(container.innerHTML).toBe('');
  });
});
