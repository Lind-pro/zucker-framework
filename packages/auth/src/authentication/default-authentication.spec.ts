import { describe, it, expect } from 'vitest';
import { DefaultAuthentication, fromJwtUser } from './default-authentication';
import {
  SimplePermission,
  DefaultDimensionType,
  SimpleDimensionType,
} from '../interfaces';
import type { Dimension } from '../interfaces';

function makeDimension(id: string, type = DefaultDimensionType.role): Dimension {
  return { id, name: id, type };
}

function makePermission(id: string, actions: string[] = []) {
  return new SimplePermission({ id, name: id, actions, dataAccesses: [] });
}

describe('DefaultAuthentication', () => {
  it('should initialise with defaults when no data given', () => {
    const auth = new DefaultAuthentication();
    expect(auth.getUser().id).toBe('');
    expect(auth.getPermissions()).toHaveLength(0);
    expect(auth.getDimensions()).toHaveLength(0);
  });

  it('should store and return user, permissions, dimensions', () => {
    const auth = new DefaultAuthentication({
      user: { id: 'u1', username: 'alice' },
      permissions: [makePermission('perm1', ['read'])],
      dimensions: [makeDimension('role1')],
    });
    expect(auth.getUser().username).toBe('alice');
    expect(auth.getPermissions()).toHaveLength(1);
    expect(auth.getDimensions()).toHaveLength(1);
  });

  // hasPermission
  it('hasPermission returns true for matching id', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('user', ['query', 'update'])],
    });
    expect(auth.hasPermission('user', 'query')).toBe(true);
  });

  it('hasPermission returns false when actions do not match', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('user', ['query'])],
    });
    expect(auth.hasPermission('user', 'delete')).toBe(false);
  });

  it('hasPermission wildcard id matches any permission', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('*', ['query'])],
    });
    expect(auth.hasPermission('anything', 'query')).toBe(true);
  });

  it('hasPermission wildcard action matches any action', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('user', ['*'])],
    });
    expect(auth.hasPermission('user', 'delete', 'update')).toBe(true);
  });

  it('hasPermission returns true when no actions specified', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('user', [])],
    });
    expect(auth.hasPermission('user')).toBe(true);
  });

  // hasDimension
  it('hasDimension returns true when dimension type exists', () => {
    const auth = new DefaultAuthentication({
      dimensions: [makeDimension('role1')],
    });
    expect(auth.hasDimension('role')).toBe(true);
  });

  it('hasDimension returns false for non-existent type', () => {
    const auth = new DefaultAuthentication({ dimensions: [] });
    expect(auth.hasDimension('role')).toBe(false);
  });

  it('hasDimension checks ids when provided', () => {
    const auth = new DefaultAuthentication({
      dimensions: [makeDimension('role1'), makeDimension('role2')],
    });
    expect(auth.hasDimension('role', 'role1')).toBe(true);
    expect(auth.hasDimension('role', 'role99')).toBe(false);
  });

  // merge
  it('merge combines permissions from two authentications', () => {
    const a = new DefaultAuthentication({
      user: { id: 'u1', username: 'alice' },
      permissions: [makePermission('perm1', ['read'])],
    });
    const b = new DefaultAuthentication({
      permissions: [makePermission('perm1', ['write']), makePermission('perm2', ['read'])],
    });
    a.merge(b);
    expect(a.getPermissions()).toHaveLength(2);
    const merged = a.getPermission('perm1');
    expect(merged!.actions).toContain('read');
    expect(merged!.actions).toContain('write');
  });

  it('merge deduplicates dimensions by type+id', () => {
    const a = new DefaultAuthentication({
      dimensions: [makeDimension('role1')],
    });
    const b = new DefaultAuthentication({
      dimensions: [makeDimension('role1'), makeDimension('role2')],
    });
    a.merge(b);
    const roleDims = a.getDimensions('role');
    expect(roleDims).toHaveLength(2);
  });

  it('merge takes user from other when current user is empty', () => {
    const a = new DefaultAuthentication();
    const b = new DefaultAuthentication({ user: { id: 'u2', username: 'bob' } });
    a.merge(b);
    expect(a.getUser().id).toBe('u2');
  });

  it('merge overrides current user when other authentication has a user', () => {
    const a = new DefaultAuthentication({ user: { id: 'u1', username: 'alice' } });
    const b = new DefaultAuthentication({ user: { id: 'u2', username: 'bob' } });
    a.merge(b);
    expect(a.getUser().id).toBe('u2');
  });

  // attributes
  it('setAttribute / getAttribute work correctly', () => {
    const auth = new DefaultAuthentication();
    auth.setAttribute('theme', 'dark');
    expect(auth.getAttribute<string>('theme')).toBe('dark');
  });

  it('merge merges attributes (other wins)', () => {
    const a = new DefaultAuthentication({ attributes: { k1: 'v1', k2: 'old' } });
    const b = new DefaultAuthentication({ attributes: { k2: 'new', k3: 'v3' } });
    a.merge(b);
    expect(a.getAttribute('k2')).toBe('new');
    expect(a.getAttribute('k3')).toBe('v3');
  });

  // setUser adds user dimension
  it('setUser adds user as a dimension', () => {
    const auth = new DefaultAuthentication();
    auth.setUser({ id: 'u1', username: 'alice' });
    expect(auth.getDimensions('user')).toHaveLength(1);
  });

  // copy
  it('copy filters permissions and dimensions', () => {
    const auth = new DefaultAuthentication({
      user: { id: 'u1', username: 'alice' },
      permissions: [makePermission('perm1', ['read', 'write'])],
      dimensions: [makeDimension('role1'), makeDimension('role2')],
    });
    const copied = auth.copy(
      (_perm, action) => action === 'read',
      (dim) => dim.id === 'role1',
    );
    expect(copied.getPermissions()[0].actions).toEqual(['read']);
    expect(copied.getDimensions()).toHaveLength(1);
  });

  // fromJwtUser
  it('fromJwtUser creates authentication from plain object', () => {
    const auth = fromJwtUser({ sub: 'u1', username: 'alice' });
    expect(auth.getUser().id).toBe('u1');
    expect(auth.getUser().username).toBe('alice');
  });

  // getDimension
  it('getDimension returns specific dimension by type and id', () => {
    const auth = new DefaultAuthentication({
      dimensions: [makeDimension('role1'), makeDimension('role2')],
    });
    expect(auth.getDimension('role', 'role1')).toBeDefined();
    expect(auth.getDimension('role', 'role99')).toBeUndefined();
  });

  // getPermission
  it('getPermission returns undefined for empty id', () => {
    const auth = new DefaultAuthentication({
      permissions: [makePermission('perm1', ['read'])],
    });
    expect(auth.getPermission('')).toBeUndefined();
  });
});
