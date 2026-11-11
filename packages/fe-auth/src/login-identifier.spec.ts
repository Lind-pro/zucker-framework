import { describe, expect, it } from 'vitest';
import { loginIdentifierInput, loginRequestBody } from './index';

describe('login identifier input', () => {
  it('maps each option to its body field and input presentation', () => {
    expect(loginIdentifierInput()).toEqual({ field: 'username', type: 'text', autoComplete: 'username', inputMode: 'text', trim: true });
    expect(loginIdentifierInput('email')).toMatchObject({ field: 'email', type: 'email', inputMode: 'email' });
    expect(loginIdentifierInput('username-or-email')).toMatchObject({ field: 'login', type: 'text', inputMode: 'email' });
    expect(Object.isFrozen(loginIdentifierInput('email'))).toBe(true);
    expect(() => loginIdentifierInput('phone' as never)).toThrow(TypeError);
    expect(() => loginIdentifierInput('toString' as never)).toThrow(TypeError);
  });

  it('builds the login body with a trimmed identifier and the password as typed', () => {
    expect(loginRequestBody(undefined, ' alice ', ' pw ')).toEqual({ username: 'alice', password: ' pw ' });
    expect(loginRequestBody('email', ' A@B.example ', 'pw')).toEqual({ email: 'A@B.example', password: 'pw' });
    expect(loginRequestBody('username-or-email', 'alice', 'pw')).toEqual({ login: 'alice', password: 'pw' });
  });
});
