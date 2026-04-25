import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthenticationHolder } from './authentication-holder';
import { DefaultAuthentication } from './default-authentication';
import type { AuthenticationSupplier, SupplierContext } from './authentication-supplier';
import { SimplePermission, DefaultDimensionType } from '../interfaces';

// Suppress NestJS Logger output
vi.mock('@nestjs/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/common')>();
  return {
    ...actual,
    Logger: class {
      log = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
  };
});

function makeAuth(userId: string, username = userId) {
  return new DefaultAuthentication({
    user: { id: userId, username },
    permissions: [
      new SimplePermission({ id: `perm-${userId}`, name: `perm-${userId}`, actions: ['read'], dataAccesses: [] }),
    ],
    dimensions: [{ id: userId, name: username, type: DefaultDimensionType.user }],
  });
}

function makeSupplier(auth: DefaultAuthentication | null, order = 100): AuthenticationSupplier {
  return {
    order,
    get: vi.fn().mockResolvedValue(auth),
    getByUserId: vi.fn().mockResolvedValue(auth),
  };
}

const ctx: SupplierContext = {
  request: { headers: {} },
};

describe('AuthenticationHolder', () => {
  it('should return null when no suppliers registered', async () => {
    const holder = new AuthenticationHolder(null);
    const result = await holder.resolve(ctx);
    expect(result).toBeNull();
  });

  it('should resolve from a single supplier', async () => {
    const auth = makeAuth('u1');
    const holder = new AuthenticationHolder([makeSupplier(auth)]);
    const result = await holder.resolve(ctx);
    expect(result).not.toBeNull();
    expect(result!.getUser().id).toBe('u1');
  });

  it('should merge results from multiple suppliers', async () => {
    const a1 = makeAuth('u1');
    const a2 = new DefaultAuthentication({
      permissions: [new SimplePermission({ id: 'extra', name: 'extra', actions: ['write'], dataAccesses: [] })],
    });
    const holder = new AuthenticationHolder([
      makeSupplier(a1, 1),
      makeSupplier(a2, 2),
    ]);
    const result = await holder.resolve(ctx);
    expect(result).not.toBeNull();
    expect(result!.getPermissions().length).toBeGreaterThanOrEqual(2);
  });

  it('should skip suppliers that return null', async () => {
    const auth = makeAuth('u1');
    const holder = new AuthenticationHolder([
      makeSupplier(null, 1),
      makeSupplier(auth, 2),
    ]);
    const result = await holder.resolve(ctx);
    expect(result!.getUser().id).toBe('u1');
  });

  it('should return null when all suppliers return null', async () => {
    const holder = new AuthenticationHolder([
      makeSupplier(null, 1),
      makeSupplier(null, 2),
    ]);
    const result = await holder.resolve(ctx);
    expect(result).toBeNull();
  });

  it('should cache result in ALS context', async () => {
    const auth = makeAuth('u1');
    const supplier = makeSupplier(auth);
    const holder = new AuthenticationHolder([supplier]);

    await holder.runInContext(async () => {
      await holder.resolve(ctx);
      await holder.resolve(ctx);
      // supplier.get should only be called once due to caching
      expect(supplier.get).toHaveBeenCalledTimes(1);
    });
  });

  it('getCurrent returns null outside ALS context', () => {
    const holder = new AuthenticationHolder(null);
    expect(holder.getCurrent()).toBeNull();
  });

  it('should sort suppliers by order', async () => {
    const callOrder: number[] = [];
    const s1: AuthenticationSupplier = {
      order: 10,
      get: vi.fn().mockImplementation(async () => { callOrder.push(10); return makeAuth('u1'); }),
    };
    const s2: AuthenticationSupplier = {
      order: 5,
      get: vi.fn().mockImplementation(async () => { callOrder.push(5); return null; }),
    };
    const holder = new AuthenticationHolder([s1, s2]);
    await holder.resolve(ctx);
    expect(callOrder[0]).toBe(5);
  });

  it('should handle supplier errors gracefully', async () => {
    const failing: AuthenticationSupplier = {
      order: 1,
      get: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ok = makeSupplier(makeAuth('u1'), 2);
    const holder = new AuthenticationHolder([failing, ok]);
    const result = await holder.resolve(ctx);
    expect(result!.getUser().id).toBe('u1');
  });

  it('resolveByUserId merges from suppliers that support it', async () => {
    const auth = makeAuth('u1');
    const supplier = makeSupplier(auth);
    const holder = new AuthenticationHolder([supplier]);
    const result = await holder.resolveByUserId('u1');
    expect(result).not.toBeNull();
    expect(supplier.getByUserId).toHaveBeenCalledWith('u1');
  });

  it('resolveByUserId returns null when no supplier has getByUserId', async () => {
    const supplier: AuthenticationSupplier = {
      order: 1,
      get: vi.fn().mockResolvedValue(null),
      // no getByUserId
    };
    const holder = new AuthenticationHolder([supplier]);
    const result = await holder.resolveByUserId('u1');
    expect(result).toBeNull();
  });
});
