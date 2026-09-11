import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { LoginAuditService } from './login-audit';
it('records successful history and login counters in the same transaction', async () => {
  const history = { create: vi.fn() };
  const users = { update: vi.fn() };
  const tx = { model: (name: string) => (name === 'history' ? history : users) };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)), model: vi.fn() };
  const service = new LoginAuditService(db as unknown as DatabaseAdapter, {
    historyModel: 'history',
    userModel: 'users',
  });
  await service.record({ userId: 'u', loginMethod: 'password', ip: '127.0.0.1' });
  expect(db.$transaction).toHaveBeenCalledOnce();
  expect(db.model).not.toHaveBeenCalled();
  expect(history.create).toHaveBeenCalledOnce();
  expect(users.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ loginCount: { increment: 1 } }) }),
  );
});
describe('best-effort failed login audit', () => {
  it('does not update successful counters and contains persistence failure', async () => {
    const error = new Error('offline');
    const onError = vi.fn();
    const db = {
      model: () => ({ create: vi.fn().mockRejectedValue(error) }),
      $transaction: vi.fn(),
    };
    const service = new LoginAuditService(db as unknown as DatabaseAdapter, {
      historyModel: 'history',
      userModel: 'users',
      onError,
    });
    await service.record({ userId: 'u', loginMethod: 'password', ip: '127.0.0.1', success: false });
    expect(onError).toHaveBeenCalledWith(error);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
