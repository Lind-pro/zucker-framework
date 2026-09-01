import { describe, expect, it } from 'vitest';
import { emailDeliveryLog, emailRecipientCount } from './email-log';

describe('email delivery logging', () => {
  it('counts one scalar recipient', () => {
    expect(emailRecipientCount('person@example.test')).toBe(1);
  });

  it('counts every array recipient', () => {
    expect(emailRecipientCount(['one@example.test', 'two@example.test'])).toBe(2);
  });

  it('reports only the provider and recipient count', () => {
    expect(emailDeliveryLog('smtp', 'secret-person@example.test')).toBe(
      'Email sent via smtp: recipients=1',
    );
  });

  it('does not expose a scalar recipient', () => {
    expect(emailDeliveryLog('smtp', 'secret-person@example.test')).not.toContain(
      'secret-person@example.test',
    );
  });

  it('does not expose any array recipient', () => {
    const message = emailDeliveryLog('resend', ['one@example.test', 'two@example.test']);
    expect(message).toBe('Email sent via resend: recipients=2');
    expect(message).not.toContain('@example.test');
  });
});
