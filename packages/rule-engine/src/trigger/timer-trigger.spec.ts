import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerTrigger } from './timer-trigger';
import type { TimerTriggerConfig } from './timer-trigger';

describe('TimerTrigger', () => {
  let trigger: TimerTrigger;

  beforeEach(() => {
    trigger = new TimerTrigger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    trigger.stop();
    vi.useRealTimers();
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('cron이 없으면 오류를 던져야 한다', () => {
      expect(() => trigger.validate({ cron: '', time: 0 } as any)).toThrow(
        'Cron expression is required',
      );
    });

    it('cron 필드가 4개 이하면 오류를 던져야 한다', () => {
      expect(() =>
        trigger.validate({ cron: '* * * *' }),
      ).toThrow('Invalid cron expression');
    });

    it('cron 필드가 8개 이상이면 오류를 던져야 한다', () => {
      expect(() =>
        trigger.validate({ cron: '* * * * * * * *' }),
      ).toThrow('Invalid cron expression');
    });

    it('유효한 5-필드 cron이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        trigger.validate({ cron: '* * * * *' }),
      ).not.toThrow();
    });

    it('유효한 6-필드 cron이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        trigger.validate({ cron: '*/5 * * * * *' }),
      ).not.toThrow();
    });
  });

  // ─── start / stop ────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('start 후 isRunning()이 true여야 한다', () => {
      const config: TimerTriggerConfig = { cron: '* * * * *' };
      trigger.start(config, vi.fn());
      expect(trigger.isRunning()).toBe(true);
    });

    it('stop 후 isRunning()이 false여야 한다', () => {
      trigger.start({ cron: '* * * * *' }, vi.fn());
      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
    });

    it('stop 후 타이머가 발화하지 않아야 한다', () => {
      const handler = vi.fn();
      trigger.start({ cron: '* * * * *' }, handler);
      trigger.stop();
      vi.advanceTimersByTime(120_000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── 인터벌 실행 ─────────────────────────────────────────────────────────────

  describe('인터벌 실행', () => {
    it('분 단위 cron에서 매 분마다 handler가 호출되어야 한다', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '* * * * *' }, handler);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('*/2 * * * * * 는 2초마다 handler를 호출해야 한다', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '*/2 * * * * *' }, handler);

      await vi.advanceTimersByTimeAsync(6_000);
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('handler 오류가 발생해도 계속 실행되어야 한다', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      trigger.start({ cron: '*/1 * * * * *' }, handler);

      await vi.advanceTimersByTimeAsync(3_000);
      // Should have been called despite errors
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(trigger.isRunning()).toBe(true);
    });
  });

  // ─── 실행 횟수 추적 ──────────────────────────────────────────────────────────

  describe('실행 횟수 추적', () => {
    it('getExecutionCount()는 handler 호출 횟수를 반환해야 한다', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '*/1 * * * * *' }, handler);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(trigger.getExecutionCount()).toBe(3);
    });

    it('maxTimes 도달 시 자동으로 stop되어야 한다', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '*/1 * * * * *', maxTimes: 2 }, handler);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(trigger.isRunning()).toBe(false);
    });

    it('getLastExecutionTime()은 마지막 실행 시간을 반환해야 한다', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '*/1 * * * * *' }, handler);

      expect(trigger.getLastExecutionTime()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(trigger.getLastExecutionTime()).toBeInstanceOf(Date);
    });
  });

  // ─── reload ──────────────────────────────────────────────────────────────────

  describe('reload()', () => {
    it('reload 후 새 설정으로 다시 시작되어야 한다', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);

      trigger.start({ cron: '* * * * *' }, handler1);
      trigger.reload({ cron: '*/1 * * * * *' }, handler2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  // ─── real cron semantics (H6) ────────────────────────────────────────────────

  describe('cron semantics', () => {
    it('a daily 02:00 cron does not fire every second or minute', async () => {
      vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));
      const handler = vi.fn().mockResolvedValue(undefined);
      trigger.start({ cron: '0 0 2 * * *', timezone: 'UTC' }, handler);
      await vi.advanceTimersByTimeAsync(15 * 3600 * 1000); // until 01:00 next day
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3600 * 1000);
      expect(handler).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('skips ticks while the previous run is in flight', async () => {
      let release!: () => void;
      const handler = vi.fn(() => new Promise<void>((r) => { release = r; }));
      trigger.start({ cron: '* * * * * *' }, handler);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(handler).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('rejects unsupported syntax instead of approximating it', () => {
      expect(() => trigger.validate({ cron: '0 0 L * *' })).toThrow();
      expect(() => trigger.validate({ cron: '0 0 * * *', timezone: 'Not/AZone' })).toThrow();
    });
  });
});
