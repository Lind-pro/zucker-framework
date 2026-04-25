import { describe, it, expect } from 'vitest';
import { RequestContext } from './request-context';

describe('RequestContext', () => {
  describe('constructor', () => {
    it('should generate correlationId if not provided', () => {
      const ctx = new RequestContext();
      expect(ctx.correlationId).toBeDefined();
      expect(ctx.correlationId.length).toBeGreaterThan(0);
    });

    it('should use provided correlationId', () => {
      const ctx = new RequestContext({ correlationId: 'test-123' });
      expect(ctx.correlationId).toBe('test-123');
    });

    it('should default locale to zh-CN', () => {
      const ctx = new RequestContext();
      expect(ctx.locale).toBe('zh-CN');
    });

    it('should record startTime', () => {
      const before = Date.now();
      const ctx = new RequestContext();
      expect(ctx.startTime).toBeGreaterThanOrEqual(before);
      expect(ctx.startTime).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('elapsed', () => {
    it('should return time since creation', async () => {
      const ctx = new RequestContext();
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.elapsed).toBeGreaterThanOrEqual(5);
    });
  });

  describe('attributes', () => {
    it('should set and get custom attributes', () => {
      const ctx = new RequestContext();
      ctx.setAttribute('foo', 42);
      expect(ctx.getAttribute<number>('foo')).toBe(42);
    });

    it('should return undefined for missing attributes', () => {
      const ctx = new RequestContext();
      expect(ctx.getAttribute('missing')).toBeUndefined();
    });
  });

  describe('toLogContext', () => {
    it('should return serializable object', () => {
      const ctx = new RequestContext({
        correlationId: 'log-test',
        user: { id: 'u1', username: 'admin' },
        tenantId: 't1',
        locale: 'en-US',
        ip: '127.0.0.1',
        path: '/api/test',
        method: 'GET',
      });
      ctx.user = { id: 'u1', username: 'admin' };

      const log = ctx.toLogContext();
      expect(log.correlationId).toBe('log-test');
      expect(log.userId).toBe('u1');
      expect(log.username).toBe('admin');
      expect(log.tenantId).toBe('t1');
      expect(log.locale).toBe('en-US');
      expect(log.ip).toBe('127.0.0.1');
      expect(log.path).toBe('/api/test');
      expect(log.method).toBe('GET');
      expect(typeof log.elapsed).toBe('number');
    });
  });

  describe('AsyncLocalStorage integration', () => {
    it('current() should return undefined outside of run()', () => {
      expect(RequestContext.current()).toBeUndefined();
    });

    it('current() should return context inside run()', () => {
      const ctx = new RequestContext({ correlationId: 'async-test' });
      RequestContext.run(ctx, () => {
        const current = RequestContext.current();
        expect(current).toBeDefined();
        expect(current!.correlationId).toBe('async-test');
      });
    });

    it('currentOrFail() should throw outside of run()', () => {
      expect(() => RequestContext.currentOrFail()).toThrow(
        'RequestContext not available',
      );
    });

    it('runNew() should create and run with new context', () => {
      RequestContext.runNew({ tenantId: 'tenant-1' }, () => {
        const ctx = RequestContext.current()!;
        expect(ctx.tenantId).toBe('tenant-1');
        expect(ctx.correlationId).toBeDefined();
      });
    });

    it('nested run() should isolate contexts', () => {
      const outer = new RequestContext({ correlationId: 'outer' });
      const inner = new RequestContext({ correlationId: 'inner' });

      RequestContext.run(outer, () => {
        expect(RequestContext.current()!.correlationId).toBe('outer');

        RequestContext.run(inner, () => {
          expect(RequestContext.current()!.correlationId).toBe('inner');
        });

        expect(RequestContext.current()!.correlationId).toBe('outer');
      });
    });

    it('getCorrelationId() should return id from current context', () => {
      const ctx = new RequestContext({ correlationId: 'compat-test' });
      RequestContext.run(ctx, () => {
        expect(RequestContext.getCorrelationId()).toBe('compat-test');
      });
    });

    it('getCorrelationId() should return undefined outside context', () => {
      expect(RequestContext.getCorrelationId()).toBeUndefined();
    });
  });
});
