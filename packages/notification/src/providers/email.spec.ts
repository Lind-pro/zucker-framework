import { afterEach, describe, expect, it, vi } from 'vitest';

const createTransport = vi.fn(() => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));

const { EmailProvider } = await import('./email');

describe('EmailProvider SMTP AUTH', () => {
  afterEach(() => createTransport.mockClear());

  it('does not configure AUTH when user and password are empty (local catcher without authentication)', () => {
    new EmailProvider({ host: 'mailpit', port: 1025, from: 'app@example.invalid', auth: { user: '', pass: '' } });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty('auth');
  });

  it('passes credentials through when they are configured', () => {
    new EmailProvider({ host: 'smtp.example.invalid', port: 587, from: 'app@example.invalid', auth: { user: 'synthetic', pass: 'synthetic-pass' } });
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ auth: { user: 'synthetic', pass: 'synthetic-pass' } });
  });
});
