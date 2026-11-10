import { ForbiddenException, Injectable, Module, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { getCurrentTenantId } from './tenant-context';
import { TenantGuard } from './tenant.guard';
import { TenantInterceptor } from './tenant.interceptor';
import { ZuckerTenantModule } from './tenant.module';
import { TENANT_AWARE_KEY, TenantAware } from './tenant.decorator';
import { TENANT_MODULE_OPTIONS } from './tenant-resolver';

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

describe('TenantGuard with a controller-level auth guard (N-M11)', () => {
  @TenantAware()
  class ProtectedController {
    handler() { return 'ok'; }
  }
  class OpenController {
    handler() { return 'ok'; }
  }
  function routeContext(Controller: new () => { handler(): string }, request: Record<string, unknown>): ExecutionContext {
    return {
      getHandler: () => Controller.prototype.handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  /** Nest order: global guards, then controller guards, then interceptors, then the handler. */
  async function dispatch(
    guard: TenantGuard,
    interceptor: TenantInterceptor,
    Controller: new () => { handler(): string },
    request: Record<string, unknown>,
    authenticate: (request: Record<string, unknown>) => void,
  ) {
    const ctx = routeContext(Controller, request);
    expect(await guard.canActivate(ctx)).toBe(true); // global TenantGuard
    authenticate(request); // controller-level auth guard
    const observable = await interceptor.intercept(ctx, { handle: () => of(getCurrentTenantId() ?? 'no-tenant') });
    return new Promise<unknown>((resolve, reject) => observable.subscribe({ next: resolve, error: reject }));
  }
  const reflector = new Reflector();

  it('a @TenantAware route is served with the tenant context once the auth guard has set request.user', async () => {
    const guard = new TenantGuard(reflector, { strategy: 'jwt' });
    const interceptor = new TenantInterceptor({ strategy: 'jwt' });
    const result = await dispatch(guard, interceptor, ProtectedController, { headers: {} }, (request) => {
      request.user = { id: 'u1', tenantId: 'tenant-a' };
    });
    expect(result).toBe('tenant-a');
  });

  it('the deferred decision is not cached as "no tenant"', async () => {
    const guard = new TenantGuard(reflector, { strategy: 'jwt' });
    const request: Record<string, unknown> = {};
    await expect(guard.canActivate(routeContext(ProtectedController, request))).resolves.toBe(true);
    request.user = { tenantId: 'tenant-a' };
    await expect(new TenantInterceptor({ strategy: 'jwt' }).intercept(routeContext(ProtectedController, request), { handle: () => of(getCurrentTenantId()) }).then(
      (observable) => new Promise((resolve) => observable.subscribe(resolve)),
    )).resolves.toBe('tenant-a');
  });

  it('answers 403 when no tenant resolves after authentication', async () => {
    const guard = new TenantGuard(reflector, { strategy: 'jwt' });
    const interceptor = new TenantInterceptor({ strategy: 'jwt' });
    await expect(dispatch(guard, interceptor, ProtectedController, { headers: {} }, (request) => {
      request.user = { id: 'u1' }; // authenticated, but without a tenant
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dispatch(guard, interceptor, ProtectedController, { headers: {} }, () => undefined))
      .rejects.toBeInstanceOf(ForbiddenException); // never authenticated
  });

  it('defers too when the tenant needs verifyTenant and there is no user yet', async () => {
    const verifyTenant = vi.fn((tenantId: string, request: { user?: { tenants?: string[] } }) => !!request.user?.tenants?.includes(tenantId));
    const options = { strategy: 'header' as const, verifyTenant };
    const guard = new TenantGuard(reflector, options);
    const interceptor = new TenantInterceptor(options);
    const request = { headers: { 'x-tenant-id': 'tenant-a' } };
    const result = await dispatch(guard, interceptor, ProtectedController, request, (req) => {
      req.user = { tenants: ['tenant-a'] };
    });
    expect(result).toBe('tenant-a');
    expect(verifyTenant).toHaveBeenCalledTimes(1);
  });

  it('with the user already set the guard still decides itself (403 without a tenant)', async () => {
    const guard = new TenantGuard(reflector, { strategy: 'jwt' });
    await expect(guard.canActivate(routeContext(ProtectedController, { user: { id: 'u1' } }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(routeContext(ProtectedController, { user: { tenantId: 'A' } }))).resolves.toBe(true);
  });

  it('does not touch routes that are not @TenantAware', async () => {
    const guard = new TenantGuard(reflector, { strategy: 'jwt' });
    const interceptor = new TenantInterceptor({ strategy: 'jwt' });
    const result = await dispatch(guard, interceptor, OpenController, {}, () => undefined);
    expect(result).toBe('no-tenant');
  });

  it('a guard registered with a misconfigured strategy but never used does not fail at construction or DI startup', async () => {
    expect(() => new TenantGuard(reflector, { strategy: 'header' })).not.toThrow();

    @Injectable()
    class Marker {}
    @Module({
      providers: [
        Marker,
        { provide: TENANT_MODULE_OPTIONS, useValue: { strategy: 'header' } },
        TenantGuard,
      ],
    })
    class AppModule {}
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    try {
      const guard = app.get(TenantGuard);
      // Routes that are not @TenantAware never build the resolver ...
      await expect(guard.canActivate(routeContext(OpenController, {}))).resolves.toBe(true);
      // ... the misconfiguration surfaces on first real use.
      await expect(guard.canActivate(routeContext(ProtectedController, { user: {} }))).rejects.toThrow(/verifyTenant/);
    } finally {
      await app.close();
    }
  });
});
