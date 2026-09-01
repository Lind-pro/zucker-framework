import { describe, expect, it, vi } from 'vitest';
import { AuditLogger, InMemoryAuditStore } from './audit-logger';

describe('AuditLogger', () => {
  it('persists only a sanitized immutable snapshot', async () => {
    const store = new InMemoryAuditStore();
    const logger = new AuditLogger(store);

    const entry = await logger.log({
      action: 'session.login_failed',
      actor: {
        id: 'attorney@example.com',
        type: 'anonymous',
        ip: '203.0.113.9',
      },
      success: false,
      error: 'Bearer secret-token',
      metadata: {
        password: 'never-log-me',
        note: 'attorney@example.com',
      },
    });

    expect(entry.id).toMatch(/^audit_[0-9a-f-]{36}$/);
    expect(store.getAll()).toEqual([
      expect.objectContaining({
        actor: {
          id: '[EMAIL]',
          type: 'anonymous',
          ip: '[IP]',
        },
        error: 'Bearer [REDACTED]',
        metadata: {
          password: '[REDACTED]',
          note: '[EMAIL]',
        },
      }),
    ]);
  });

  it('fails closed when a required audit store write fails', async () => {
    const logger = new AuditLogger({
      append: vi.fn().mockRejectedValue(new Error('postgres://admin:secret@db.example/audit')),
      query: vi.fn(),
    });

    await expect(
      logger.logRequired({
        action: 'matter.created',
        actor: { id: 'user-1', type: 'user' },
      }),
    ).rejects.toThrow('Required audit log write failed');
  });
});
