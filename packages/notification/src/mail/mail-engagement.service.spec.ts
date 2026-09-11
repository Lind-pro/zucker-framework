// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MailEngagementService } from './mail-engagement.service';
describe('mail engagement SQL boundary', () => {
  it('parameterizes identifiers in callback data and requests retry for recent unmatched receipts', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new MailEngagementService({
      table: 'mail_history',
      query,
      trackingConfigured: () => true,
    });
    const id = "receipt'; DROP TABLE mail_history; --";
    await expect(
      service.record({
        type: 'email.opened',
        created_at: new Date().toISOString(),
        data: { email_id: id },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(query.mock.calls[0][0]).not.toContain(id);
    expect(query.mock.calls[0][1]).toContain(id);
    expect(query.mock.calls[0][0]).toContain('LEAST');
    expect(query.mock.calls[0][0]).toContain('GREATEST');
  });
  it('ignores old unrelated receipts and rejects unsafe configured table names', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const service = new MailEngagementService({
      table: 'mail_history',
      query,
      trackingConfigured: () => false,
    });
    await service.record({
      type: 'email.clicked',
      created_at: '2000-01-01',
      data: { email_id: 'old' },
    });
    await service.record({
      type: 'unknown',
      created_at: new Date().toISOString(),
      data: { email_id: 'other' },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(
      () =>
        new MailEngagementService({ table: 'mail; drop', query, trackingConfigured: () => false }),
    ).toThrow();
  });
});
