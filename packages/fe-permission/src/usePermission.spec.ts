import { createUsePermission } from './usePermission';
import type { AuthStore } from '@zucker-framework/fe-auth';

// Minimal mock for React hooks in a non-component context
vi.mock('react', () => ({
  useCallback: (fn: Function) => fn,
}));

describe('createUsePermission', () => {
  function createHook(permissions: string[]) {
    const mockUseAuthStore = vi.fn((selector: (state: AuthStore) => unknown) => {
      const fakeState = { permissions } as AuthStore;
      return selector(fakeState);
    });

    const usePermission = createUsePermission({ useAuthStore: mockUseAuthStore });
    return usePermission();
  }

  it('should return false for any permission when permissions are empty', () => {
    const { hasPermission } = createHook([]);
    expect(hasPermission('user:read')).toBe(false);
  });

  it('should match exact permission code', () => {
    const { hasPermission } = createHook(['user:read', 'user:write']);
    expect(hasPermission('user:read')).toBe(true);
    expect(hasPermission('user:delete')).toBe(false);
  });

  it('should grant all with superadmin', () => {
    const { hasPermission } = createHook(['superadmin']);
    expect(hasPermission('anything:here')).toBe(true);
  });

  it('should grant all with wildcard *', () => {
    const { hasPermission } = createHook(['*']);
    expect(hasPermission('some:perm')).toBe(true);
  });

  it('should match resource wildcard (resource:*)', () => {
    const { hasPermission } = createHook(['user:*']);
    expect(hasPermission('user:read')).toBe(true);
    expect(hasPermission('user:write')).toBe(true);
    expect(hasPermission('post:read')).toBe(false);
  });

  it('hasAnyPermission should return true if any match', () => {
    const { hasAnyPermission } = createHook(['user:read']);
    expect(hasAnyPermission(['user:read', 'user:write'])).toBe(true);
    expect(hasAnyPermission(['post:read'])).toBe(false);
  });

  it('hasAllPermissions should return true only if all match', () => {
    const { hasAllPermissions } = createHook(['user:read', 'user:write']);
    expect(hasAllPermissions(['user:read', 'user:write'])).toBe(true);
    expect(hasAllPermissions(['user:read', 'user:delete'])).toBe(false);
  });

  it('hasAnyPermission returns true for superadmin', () => {
    const { hasAnyPermission } = createHook(['superadmin']);
    expect(hasAnyPermission(['anything'])).toBe(true);
  });

  it('getAllPermissions should return the permissions array', () => {
    const { getAllPermissions } = createHook(['a', 'b']);
    expect(getAllPermissions()).toEqual(['a', 'b']);
  });
});
