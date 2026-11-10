import { describe, it, expect, vi } from 'vitest';
import { DatabaseOneTimeTicketStore, OneTimeTicketService } from './one-time-ticket';
import type { OneTimeTicketRecord } from './one-time-ticket';

interface Ticket extends OneTimeTicketRecord { subject: string }
describe('one-time opaque tickets', () => {
  it('stores only a SHA-256 digest and claims before returning application data', async () => {
    let row: Ticket | undefined;
    const model = {
      create: vi.fn(async ({ data }) => { row = { ...data, id: 'ticket', createdAt: new Date(), consumedAt: null }; return row; }),
      findUnique: vi.fn(async () => row), deleteMany: vi.fn(),
      updateMany: vi.fn(async () => {
        if (!row || row.consumedAt) return { count: 0 };
        row.consumedAt = new Date(); return { count: 1 };
      }),
    };
    const service = new OneTimeTicketService(new DatabaseOneTimeTicketStore<Ticket>(model as never), {
      expirySeconds: 120, consumedRetentionSeconds: 3600,
    });
    const code = await service.issue({ subject: 's' });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.tokenHash).not.toBe(code);
    const results = await Promise.allSettled([service.consume(code), service.consume(code)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(model.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ticket', consumedAt: null, expiresAt: { gt: expect.any(Date) } },
    }));
  });
  it('propagates persistence errors without returning a usable unsaved ticket', async () => {
    const store = { create: vi.fn().mockRejectedValue(new Error('database unavailable')), cleanup: vi.fn(), find: vi.fn(), claim: vi.fn() };
    const service = new OneTimeTicketService<Ticket>(store, { expirySeconds: 120, consumedRetentionSeconds: 3600 });
    await expect(service.issue({ subject: 's' })).rejects.toThrow('database unavailable');
  });
});
