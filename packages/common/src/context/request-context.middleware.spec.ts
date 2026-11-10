import { describe, expect, it } from 'vitest';
import { RequestContext } from './request-context';
import { RequestContextMiddleware } from './request-context.middleware';

function run(middleware: RequestContextMiddleware, headers: Record<string, string>) {
  const set: Record<string, string> = {};
  let ctx: RequestContext | undefined;
  middleware.use({ headers }, { setHeader: (n, v) => (set[n] = v) }, () => {
    ctx = RequestContext.current();
  });
  return { ctx: ctx!, set };
}

describe('RequestContextMiddleware', () => {
  it('ignores the client tenant header by default', () => {
    const { ctx } = run(new RequestContextMiddleware(), { 'x-tenant-id': 'victim' });
    expect(ctx.tenantId).toBeUndefined();
  });

  it('reads the tenant header only when explicitly trusted', () => {
    const { ctx } = run(new RequestContextMiddleware({ trustTenantHeader: true }), { 'x-tenant-id': 't1' });
    expect(ctx.tenantId).toBe('t1');
  });

  it('replaces an unsafe correlation id and keeps a safe one', () => {
    const bad = run(new RequestContextMiddleware(), { 'x-correlation-id': 'a\r\nSet-Cookie: x' });
    expect(bad.ctx.correlationId).not.toContain('\n');
    expect(bad.set['x-correlation-id']).toBe(bad.ctx.correlationId);
    const good = run(new RequestContextMiddleware(), { 'x-correlation-id': 'req-123.abc' });
    expect(good.ctx.correlationId).toBe('req-123.abc');
  });
});
