import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShakeLimiter } from './shake-limit';
import type { ShakeLimitConfig } from './shake-limit';

describe('ShakeLimiter (executor)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 비활성 모드 ─────────────────────────────────────────────────────────────

  describe('비활성 모드 (enabled=false)', () => {
    it('enabled=false이면 push마다 즉시 콜백이 호출되어야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: false, time: 10, threshold: 3 };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('a');
      limiter.push('b');
      limiter.push('c');

      expect(cb).toHaveBeenCalledTimes(3);
      expect(cb.mock.calls[0][0]).toEqual({ data: 'a', total: 1 });
    });

    it('time=0이면 즉시 콜백을 호출해야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 0, threshold: 1 };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('x');
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // ─── alarmFirst=false 모드 (기본) ────────────────────────────────────────────

  describe('alarmFirst=false 모드 (윈도우 종료 후 마지막 데이터 콜백)', () => {
    it('임계값 미달이면 윈도우가 끝나도 콜백이 호출되지 않아야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 1, threshold: 5, alarmFirst: false };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('only-one');
      vi.advanceTimersByTime(1100);

      expect(cb).not.toHaveBeenCalled();
    });

    it('임계값 충족 시 윈도우 종료 시점에 마지막 데이터로 콜백이 호출되어야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 1, threshold: 3, alarmFirst: false };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('first');
      limiter.push('second');
      limiter.push('last');

      vi.advanceTimersByTime(1100);

      expect(cb).toHaveBeenCalledOnce();
      expect(cb.mock.calls[0][0]).toMatchObject({ data: 'last', total: 3 });
    });

    it('윈도우 종료 후 두 번째 윈도우에서도 독립적으로 동작해야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 1, threshold: 2, alarmFirst: false };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('w1-a');
      limiter.push('w1-b');
      vi.advanceTimersByTime(1100);

      limiter.push('w2-a');
      limiter.push('w2-b');
      vi.advanceTimersByTime(1100);

      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  // ─── alarmFirst=true 모드 ─────────────────────────────────────────────────────

  describe('alarmFirst=true 모드 (임계값 도달 즉시 첫 데이터 콜백)', () => {
    it('임계값 도달 즉시 첫 번째 데이터로 콜백이 호출되어야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 60, threshold: 3, alarmFirst: true };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('first');
      expect(cb).not.toHaveBeenCalled();

      limiter.push('second');
      expect(cb).not.toHaveBeenCalled();

      limiter.push('third');  // threshold reached
      expect(cb).toHaveBeenCalledOnce();
      expect(cb.mock.calls[0][0]).toMatchObject({ data: 'first', total: 3 });
    });

    it('임계값 도달 후 같은 윈도우에서 추가 push는 콜백을 호출하지 않아야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 60, threshold: 2, alarmFirst: true };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('a');
      limiter.push('b'); // fires
      limiter.push('c'); // should not fire
      limiter.push('d'); // should not fire

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getCurrentCount / dispose ──────────────────────────────────────────────

  describe('getCurrentCount() 및 dispose()', () => {
    it('getCurrentCount()는 현재 윈도우 내 카운트를 반환해야 한다', () => {
      const config: ShakeLimitConfig = { enabled: true, time: 60, threshold: 10 };
      const limiter = new ShakeLimiter(config, vi.fn());

      expect(limiter.getCurrentCount()).toBe(0);
      limiter.push('a');
      expect(limiter.getCurrentCount()).toBe(1);
      limiter.push('b');
      expect(limiter.getCurrentCount()).toBe(2);
    });

    it('dispose() 후 상태가 초기화되어야 한다', () => {
      const config: ShakeLimitConfig = { enabled: true, time: 60, threshold: 2 };
      const limiter = new ShakeLimiter(config, vi.fn());

      limiter.push('a');
      limiter.push('b');
      limiter.dispose();

      expect(limiter.getCurrentCount()).toBe(0);
    });

    it('dispose() 후 타이머가 발화하지 않아야 한다', () => {
      const cb = vi.fn();
      const config: ShakeLimitConfig = { enabled: true, time: 1, threshold: 1 };
      const limiter = new ShakeLimiter(config, cb);

      limiter.push('x');
      limiter.dispose();
      vi.advanceTimersByTime(1100);

      // cb should not have been called (disposed before window end)
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
