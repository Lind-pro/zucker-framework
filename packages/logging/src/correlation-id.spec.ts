import { describe, it, expect, vi } from 'vitest';
import {
  getCorrelationId,
  runWithCorrelationId,
  runWithNewCorrelationId,
  CorrelationIdMiddleware,
  CORRELATION_ID_HEADER,
} from './correlation-id';

describe('Correlation ID', () => {
  describe('getCorrelationId', () => {
    it('should return undefined outside of correlation context', () => {
      expect(getCorrelationId()).toBeUndefined();
    });

    it('should return the correlation ID within context', () => {
      const result = runWithCorrelationId('test-id-123', () => {
        return getCorrelationId();
      });
      expect(result).toBe('test-id-123');
    });
  });

  describe('runWithCorrelationId', () => {
    it('should propagate correlation ID to nested calls', () => {
      runWithCorrelationId('outer-id', () => {
        expect(getCorrelationId()).toBe('outer-id');
      });
    });

    it('should support async functions', async () => {
      const result = await runWithCorrelationId('async-id', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getCorrelationId();
      });
      expect(result).toBe('async-id');
    });

    it('should isolate correlation IDs between runs', () => {
      runWithCorrelationId('id-1', () => {
        expect(getCorrelationId()).toBe('id-1');
      });
      runWithCorrelationId('id-2', () => {
        expect(getCorrelationId()).toBe('id-2');
      });
    });
  });

  describe('runWithNewCorrelationId', () => {
    it('should generate a UUID-format correlation ID', () => {
      const result = runWithNewCorrelationId(() => {
        return getCorrelationId();
      });
      expect(result).toBeDefined();
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs for each call', () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        runWithNewCorrelationId(() => {
          ids.push(getCorrelationId()!);
        });
      }
      const unique = new Set(ids);
      expect(unique.size).toBe(3);
    });
  });

  describe('CorrelationIdMiddleware', () => {
    it('should use existing correlation ID from request header', () => {
      const middleware = new CorrelationIdMiddleware();
      const req = { headers: { [CORRELATION_ID_HEADER]: 'existing-id' } };
      const res = { setHeader: vi.fn() };
      let captured: string | undefined;

      middleware.use(req, res, () => {
        captured = getCorrelationId();
      });

      expect(captured).toBe('existing-id');
      expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'existing-id');
    });

    it('should generate a correlation ID when header is missing', () => {
      const middleware = new CorrelationIdMiddleware();
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };
      let captured: string | undefined;

      middleware.use(req, res, () => {
        captured = getCorrelationId();
      });

      expect(captured).toBeDefined();
      expect(captured!.length).toBeGreaterThan(0);
      expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, expect.any(String));
    });

    it('should set response header with the correlation ID', () => {
      const middleware = new CorrelationIdMiddleware();
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      middleware.use(req, res, () => {});

      expect(res.setHeader).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        expect.any(String),
      );
    });
  });

  describe('CORRELATION_ID_HEADER', () => {
    it('should be x-correlation-id', () => {
      expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
    });
  });
});
