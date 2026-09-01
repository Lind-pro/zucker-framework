import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  describe('CLOSED state', () => {
    it('should pass through successful calls', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should count failures but stay CLOSED below threshold', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });

      for (let i = 0; i < 2; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }

      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should transition to OPEN when threshold reached', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }

      expect(breaker.getState()).toBe('OPEN');
    });

    it('should reset failure count on success', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });

      // 2 failures
      for (let i = 0; i < 2; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      }
      // 1 success resets counter
      await breaker.execute(async () => 'ok');

      // 2 more failures — should still be CLOSED (counter was reset)
      for (let i = 0; i < 2; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      }
      expect(breaker.getState()).toBe('CLOSED');
    });
  });

  describe('OPEN state', () => {
    it('should reject calls immediately with CircuitOpenError', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      await expect(breaker.execute(async () => 'never reached')).rejects.toThrow(CircuitOpenError);
    });

    it('CircuitOpenError should include retryAfterMs', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();

      try {
        await breaker.execute(async () => 'x');
      } catch (e) {
        expect(e).toBeInstanceOf(CircuitOpenError);
        expect((e as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(5000);
        expect((e as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      }
    });
  });

  describe('HALF_OPEN state', () => {
    it('should transition to HALF_OPEN after resetTimeout', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      await new Promise((r) => setTimeout(r, 60));
      expect(breaker.getState()).toBe('HALF_OPEN');
    });

    it('should transition to CLOSED on success in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 60));

      const result = await breaker.execute(async () => 'recovered');
      expect(result).toBe('recovered');
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should transition back to OPEN on failure in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 60));

      await expect(breaker.execute(async () => { throw new Error('still broken'); })).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');
    });

    it('should limit HALF_OPEN attempts', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMax: 1 });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 60));

      // First HALF_OPEN attempt allowed (but fails)
      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow(Error);

      // Now back to OPEN, second attempt rejected
      await expect(breaker.execute(async () => 'x')).rejects.toThrow(CircuitOpenError);
    });
  });

  describe('onStateChange callback', () => {
    it('should fire on state transitions', async () => {
      const transitions: Array<[string, string]> = [];
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 50,
        onStateChange: (from, to) => transitions.push([from, to]),
      });

      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      expect(transitions).toEqual([['CLOSED', 'OPEN']]);

      await new Promise((r) => setTimeout(r, 60));
      await breaker.execute(async () => 'ok');
      expect(transitions).toEqual([
        ['CLOSED', 'OPEN'],
        ['OPEN', 'HALF_OPEN'],
        ['HALF_OPEN', 'CLOSED'],
      ]);
    });
  });

  describe('getStats', () => {
    it('should track call statistics', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });

      await breaker.execute(async () => 'ok');
      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      // Now OPEN — next call rejected
      try { await breaker.execute(async () => 'x'); } catch {}

      const stats = breaker.getStats();
      expect(stats.totalCalls).toBe(4);
      expect(stats.totalFailures).toBe(2);
      expect(stats.totalRejected).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset to CLOSED and clear stats', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 });
      await expect(breaker.execute(async () => { throw new Error(); })).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      breaker.reset();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getStats().totalCalls).toBe(0);

      const result = await breaker.execute(async () => 'works');
      expect(result).toBe('works');
    });
  });

  describe('executeSync', () => {
    it('should work with synchronous functions', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });
      const result = breaker.executeSync(() => 42);
      expect(result).toBe(42);
    });
  });
});
