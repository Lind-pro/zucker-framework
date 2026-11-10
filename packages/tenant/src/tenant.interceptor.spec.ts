import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { getCurrentTenantId } from './tenant-context';
import { TenantGuard } from './tenant.guard';
import { TenantInterceptor } from './tenant.interceptor';
import { ZuckerTenantModule } from './tenant.module';
import { TENANT_AWARE_KEY } from './tenant.decorator';

function http(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
const capture: CallHandler = { handle: () => of(getCurrentTenantId()) };

async function run(interceptor: TenantInterceptor, request: Record<string, unknown>, next = capture) {
  const observable = await interceptor.intercept(http(request), next);
  return new Promise((resolve, reject) => observable.subscribe({ next: resolve, error: reject }));
}

describe('TenantInterceptor (H2)', () => {
  it('defaults to the authenticated user tenant and ignores client headers', async () => {
    const interceptor = new TenantInterceptor();
    await expect(run(interceptor, { headers: { 'x-tenant-id': 'B' }, user: { tenantId: 'A' } })).resolves.toBe('A');
    await expect(run(interceptor, { headers: { 'x-tenant-id': 'B' } })).resolves.toBeUndefined();
  });

  it('refuses header/subdomain strategies without verifyTenant or explicit trust', () => {
    expect(() => new TenantInterceptor({ strategy: 'header' })).toThrow(/verifyTenant/);
    expect(() => new TenantInterceptor({ strategy: 'subdomain' })).toThrow(/verifyTenant/);
    expect(() => ZuckerTenantModule.forRoot({ strategy: 'header' })).toThrow(/verifyTenant/);
  });

  it('rejects a header tenant the user is not a member of', async () => {
    const verifyTenant = vi.fn((tenantId: string, request) => request.user?.tenants?.includes(tenantId));
    const interceptor = new TenantInterceptor({ strategy: 'header', verifyTenant });
    const user = { tenants: ['A'] };
    await expect(run(interceptor, { headers: { 'x-tenant-id': 'A' }, user })).resolves.toBe('A');
    await expect(run(interceptor, { headers: { 'x-tenant-id': 'B' }, user })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['comma-joined', 'A, B'],
    ['array', ['A', 'B']],
    ['SQL', "a'; DROP SCHEMA x; --"],
    ['too long', 'a'.repeat(65)],
  ])('rejects a malformed %s tenant ID with 400', async (_name, value) => {
    const interceptor = new TenantInterceptor({ strategy: 'header', trustClientTenant: true });
    await expect(run(interceptor, { headers: { 'x-tenant-id': value } })).rejects.toMatchObject({ status: 400, code: 'TENANT_INVALID' });
  });

  it('unsubscribes the handler when the client disconnects', async () => {
    const teardown = vi.fn();
    const next: CallHandler = { handle: () => new Observable(() => teardown) };
    const observable = await new TenantInterceptor().intercept(http({ user: { tenantId: 'A' } }), next);
    observable.subscribe().unsubscribe();
    expect(teardown).toHaveBeenCalledOnce();
  });
});

describe('TenantGuard (M11)', () => {
  const tenantAware = { getAllAndOverride: (key: string) => key === TENANT_AWARE_KEY } as unknown as Reflector;

  it('resolves the tenant itself instead of reading the interceptor context', async () => {
    const guard = new TenantGuard(tenantAware, { strategy: 'jwt' });
    await expect(guard.canActivate(http({ user: { tenantId: 'A' } }))).resolves.toBe(true);
    await expect(guard.canActivate(http({ user: {} }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('verifies the tenant once and the interceptor reuses the result', async () => {
    const verifyTenant = vi.fn(() => true);
    const options = { strategy: 'header' as const, verifyTenant };
    const request = { headers: { 'x-tenant-id': 'A' } };
    await new TenantGuard(tenantAware, options).canActivate(http(request));
    await expect(run(new TenantInterceptor(options), request)).resolves.toBe('A');
    expect(verifyTenant).toHaveBeenCalledOnce();
  });

  it('forRootAsync installs the guard when enableGuard is requested', () => {
    const guard = new TenantGuard(tenantAware);
    for (const [outer, inner, expected] of [[true, false, true], [false, true, true], [false, false, false]] as const) {
      const definition = ZuckerTenantModule.forRootAsync({ enableGuard: outer, useFactory: () => ({}) });
      const provider = definition.providers!.find(
        p => typeof p === 'object' && 'provide' in p && p.provide === APP_GUARD,
      ) as unknown as { useFactory: (...args: unknown[]) => unknown };
      expect(provider.useFactory({ enableGuard: inner }, guard) === guard).toBe(expected);
    }
  });
});
