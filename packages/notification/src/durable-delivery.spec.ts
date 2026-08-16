import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_RETRY_POLICY,
  NotificationDeliveryError,
  classifyNotificationDeliveryError,
  notificationRetryDelayMs,
} from './durable-delivery';

describe('durable notification delivery primitives', () => {
  it('指数退避受上限约束，并支持确定性 jitter', () => {
    const policy = {
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 3_000,
      jitterRatio: 0.2,
    };
    expect(notificationRetryDelayMs(1, policy, () => 0)).toBe(800);
    expect(notificationRetryDelayMs(2, policy, () => 0.5)).toBe(2_000);
    expect(notificationRetryDelayMs(5, policy, () => 1)).toBe(3_000);
  });

  it('拒绝无效 attempt 和退避配置', () => {
    expect(() => notificationRetryDelayMs(0)).toThrow(RangeError);
    expect(() =>
      notificationRetryDelayMs(1, {
        ...DEFAULT_NOTIFICATION_RETRY_POLICY,
        jitterRatio: 2,
      }),
    ).toThrow(RangeError);
  });

  it('显式错误保留 code/retryable，但未知错误不暴露原文', () => {
    expect(
      classifyNotificationDeliveryError(
        new NotificationDeliveryError('private', 'RATE_LIMITED', true, 200),
      ),
    ).toEqual({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 200 });
    expect(
      classifyNotificationDeliveryError(new Error('secret provider response')),
    ).toEqual({ code: 'NOTIFICATION_DELIVERY_FAILED', retryable: true });
  });
});
