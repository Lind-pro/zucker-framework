import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelayAction } from './delay-action';
import type { DelayActionConfig } from './delay-action';

describe('DelayAction', () => {
  let action: DelayAction;

  beforeEach(() => {
    action = new DelayAction();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should apply fixed delay in seconds', async () => {
    const config: DelayActionConfig = {
      pauseType: 'delay',
      timeout: 2,
      timeoutUnits: 'seconds',
    };
    const promise = action.execute(config, { x: 1 });
    vi.advanceTimersByTime(2000);
    const result = await promise;
    expect(result).toEqual({ x: 1 });
  });

  it('should apply fixed delay in milliseconds', async () => {
    const config: DelayActionConfig = {
      pauseType: 'delay',
      timeout: 500,
      timeoutUnits: 'milliseconds',
    };
    const promise = action.execute(config, { a: 'b' });
    vi.advanceTimersByTime(500);
    const result = await promise;
    expect(result).toEqual({ a: 'b' });
  });

  it('should apply fixed delay in minutes', async () => {
    const config: DelayActionConfig = {
      pauseType: 'delay',
      timeout: 1,
      timeoutUnits: 'minutes',
    };
    const promise = action.execute(config, {});
    vi.advanceTimersByTime(60_000);
    const result = await promise;
    expect(result).toEqual({});
  });

  it('should apply fixed delay in hours', async () => {
    const config: DelayActionConfig = {
      pauseType: 'delay',
      timeout: 1,
      timeoutUnits: 'hours',
    };
    const promise = action.execute(config, {});
    vi.advanceTimersByTime(3_600_000);
    const result = await promise;
    expect(result).toEqual({});
  });

  it('should use upstream delay value for delayv type', async () => {
    const config: DelayActionConfig = { pauseType: 'delayv' };
    const promise = action.execute(config, { delay: 100 });
    vi.advanceTimersByTime(100);
    const result = await promise;
    expect(result).toEqual({ delay: 100 });
  });

  it('should return 0 delay for delayv when data.delay is undefined', async () => {
    const config: DelayActionConfig = { pauseType: 'delayv' };
    const result = await action.execute(config, {});
    expect(result).toEqual({});
  });

  it('should return 0 delay for delayv when data.delay is not a finite number', async () => {
    const config: DelayActionConfig = { pauseType: 'delayv' };
    const result = await action.execute(config, { delay: 'abc' });
    expect(result).toEqual({ delay: 'abc' });
  });

  it('should return 0 delay for rate type (handled at stream level)', async () => {
    const config: DelayActionConfig = {
      pauseType: 'rate',
      rate: 10,
      nbRateUnits: 1,
      rateUnits: 'seconds',
    };
    const result = await action.execute(config, { data: true });
    expect(result).toEqual({ data: true });
  });

  it('should apply random delay within bounds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const config: DelayActionConfig = {
      pauseType: 'random',
      randomFirst: 1,
      randomLast: 3,
      randomUnits: 'seconds',
    };
    // With random=0.5: delay = 1000 + 0.5 * (3000-1000) = 2000
    const promise = action.execute(config, {});
    vi.advanceTimersByTime(2000);
    const result = await promise;
    expect(result).toEqual({});
    vi.restoreAllMocks();
  });

  it('should return data unchanged for unknown pause type', async () => {
    const config = { pauseType: 'unknown' as any };
    const result = await action.execute(config, { key: 'val' });
    expect(result).toEqual({ key: 'val' });
  });
});
