// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { dispatchMailBatch, type MailBatchOptions } from './mail-batch';
import type { MailService } from './mail.service';
const options = (): MailBatchOptions => ({
  template: 'notice',
  subject: 'Notice',
  concurrency: 1,
  deduplicationWindowMs: 60_000,
  failedSamples: [],
  recipients: ['one', 'two', 'three'].map((id) => ({ id, email: `${id}@example.test`, data: {} })),
});
describe('mail batch execution', () => {
  it('deduplicates recent recipients and stops after daily quota exhaustion', async () => {
    const sendResolved = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'daily quota exhausted' });
    const mail = {
      history: { sentUserIds: vi.fn().mockResolvedValue(['one']) },
      resolveTemplate: vi.fn().mockResolvedValue({ en: 'Hello' }),
      sendResolved,
      isDailyQuota: () => true,
    } as unknown as MailService;
    const result = await dispatchMailBatch(mail, options());
    expect(result).toEqual({ attempted: 1, sent: 0, skipped: 2, quotaExhausted: true });
    expect(sendResolved).toHaveBeenCalledTimes(1);
    expect(sendResolved.mock.calls[0][0]).toBe('two@example.test');
  });
  it('continues after an individual throw and limits active sends to configured concurrency', async () => {
    let active = 0,
      peak = 0;
    const sendResolved = vi.fn(async (email: string) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (email.startsWith('two')) throw new Error('invalid envelope');
      return { success: true, error: null };
    });
    const mail = {
      history: { sentUserIds: async () => [] },
      resolveTemplate: async () => ({ en: 'Hello' }),
      sendResolved,
      isDailyQuota: () => false,
    } as unknown as MailService;
    const input = { ...options(), concurrency: 2 };
    expect(await dispatchMailBatch(mail, input)).toMatchObject({
      attempted: 3,
      sent: 2,
      skipped: 0,
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(input.failedSamples).toEqual([
      { email: 'two@example.test', reason: 'invalid envelope' },
    ]);
  });
});
