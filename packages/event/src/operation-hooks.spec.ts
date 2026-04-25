import { describe, it, expect, vi } from 'vitest';
import { OperationHookRegistry } from './operation-hooks';

describe('OperationHookRegistry', () => {
  describe('register and execute', () => {
    it('should execute before hooks', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      registry.register('test.op', 'before', handler);

      const ctx = registry.createContext('test.op', { key: 'value' });
      await registry.executeBefore(ctx);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].operation).toBe('test.op');
      expect(handler.mock.calls[0][0].data).toEqual({ key: 'value' });
    });

    it('should execute after hooks', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      registry.register('test.op', 'after', handler);

      const ctx = registry.createContext('test.op', {});
      ctx.result = { id: '1' };
      await registry.executeAfter(ctx);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancellation', () => {
    it('should allow hook to cancel operation', async () => {
      const registry = new OperationHookRegistry();
      registry.register('upload', 'before', (ctx) => {
        ctx.cancel('File too large');
      });

      const ctx = registry.createContext('upload', { size: 1e9 });
      await registry.executeBefore(ctx);

      expect(ctx.cancelled).toBe(true);
      expect(ctx.cancelReason).toBe('File too large');
    });

    it('should stop executing hooks after cancellation', async () => {
      const registry = new OperationHookRegistry();
      const firstHook = vi.fn((ctx) => ctx.cancel('stopped'));
      const secondHook = vi.fn();

      registry.register('op', 'before', firstHook, { priority: 10 });
      registry.register('op', 'before', secondHook, { priority: 0 });

      const ctx = registry.createContext('op', {});
      await registry.executeBefore(ctx);

      expect(firstHook).toHaveBeenCalledTimes(1);
      expect(secondHook).not.toHaveBeenCalled();
    });
  });

  describe('wildcard matching', () => {
    it('should match exact operation', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      registry.register('storage.upload', 'before', handler);

      const ctx = registry.createContext('storage.upload', {});
      await registry.executeBefore(ctx);
      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      const ctx2 = registry.createContext('storage.delete', {});
      await registry.executeBefore(ctx2);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should match single wildcard (*)', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      registry.register('storage.*', 'before', handler);

      const ctx1 = registry.createContext('storage.upload', {});
      await registry.executeBefore(ctx1);
      expect(handler).toHaveBeenCalledTimes(1);

      const ctx2 = registry.createContext('storage.delete', {});
      await registry.executeBefore(ctx2);
      expect(handler).toHaveBeenCalledTimes(2);

      const ctx3 = registry.createContext('auth.login', {});
      await registry.executeBefore(ctx3);
      expect(handler).toHaveBeenCalledTimes(2); // not called
    });

    it('should match global wildcard (*)', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      registry.register('*', 'before', handler);

      const ctx = registry.createContext('anything', {});
      await registry.executeBefore(ctx);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('priority ordering', () => {
    it('should execute higher priority hooks first', async () => {
      const registry = new OperationHookRegistry();
      const order: number[] = [];

      registry.register('op', 'before', () => { order.push(1); }, { priority: 1 });
      registry.register('op', 'before', () => { order.push(10); }, { priority: 10 });
      registry.register('op', 'before', () => { order.push(5); }, { priority: 5 });

      const ctx = registry.createContext('op', {});
      await registry.executeBefore(ctx);

      expect(order).toEqual([10, 5, 1]);
    });
  });

  describe('error handling', () => {
    it('should cancel operation if before hook throws', async () => {
      const registry = new OperationHookRegistry();
      registry.register('op', 'before', () => {
        throw new Error('validation failed');
      });

      const ctx = registry.createContext('op', {});
      await registry.executeBefore(ctx);

      expect(ctx.cancelled).toBe(true);
      expect(ctx.cancelReason).toContain('validation failed');
    });

    it('should not cancel on after hook errors', async () => {
      const registry = new OperationHookRegistry();
      registry.register('op', 'after', () => {
        throw new Error('logging failed');
      });

      const ctx = registry.createContext('op', {});
      ctx.cancelled = false;
      await registry.executeAfter(ctx);

      expect(ctx.cancelled).toBe(false); // after hooks don't cancel
    });
  });

  describe('unregister', () => {
    it('should remove hook when unregister function is called', async () => {
      const registry = new OperationHookRegistry();
      const handler = vi.fn();
      const unregister = registry.register('op', 'before', handler);

      expect(registry.size).toBe(1);
      unregister();
      expect(registry.size).toBe(0);

      const ctx = registry.createContext('op', {});
      await registry.executeBefore(ctx);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('context attributes', () => {
    it('should allow hooks to share data via attributes', async () => {
      const registry = new OperationHookRegistry();

      registry.register('op', 'before', (ctx) => {
        ctx.attributes.set('startTime', Date.now());
      }, { priority: 10 });

      registry.register('op', 'before', (ctx) => {
        const start = ctx.attributes.get('startTime');
        expect(start).toBeDefined();
      }, { priority: 0 });

      const ctx = registry.createContext('op', {});
      await registry.executeBefore(ctx);
    });
  });
});
