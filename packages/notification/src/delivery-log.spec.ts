import { describe, expect, it } from 'vitest';
import {
  notificationDeliveryLog,
  notificationFailureCode,
  notificationRecipientCount,
} from './delivery-log';

describe('notification safe logging', () => {
  it('只记录收件人数，不记录地址或主题', () => {
    const log = notificationDeliveryLog(
      'EMAIL',
      'resend',
      ['private@example.com', 'other@example.com'],
    );
    expect(log).toBe(
      'Notification sent: channel=EMAIL, provider=resend, recipients=2',
    );
    expect(log).not.toContain('@');
    expect(notificationRecipientCount('one@example.com')).toBe(1);
  });

  it('只允许低基数错误 code，不回显 Provider 原文', () => {
    expect(notificationFailureCode({ code: 'RATE_LIMITED' })).toBe(
      'RATE_LIMITED',
    );
    expect(
      notificationFailureCode({
        code: 'recipient@example.com was rejected',
        message: 'private provider response',
      }),
    ).toBe('NOTIFICATION_FAILED');
  });
});
