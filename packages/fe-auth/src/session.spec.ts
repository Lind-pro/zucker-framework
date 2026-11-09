import { describe, expect, it, vi } from 'vitest';
import { acceptsSessionToken, createSessionRequestScope, jwtSessionKey, sessionIdentity, type SessionSnapshot } from './session';

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) => `header.${encode(claims)}.signature`;
const key = jwtSessionKey(['sub', 'sid', 'cv']);
const user = { id: 'user-1' };

describe('jwtSessionKey', () => {
  it('identifies a session by the configured claims only', () => {
    const first = jwt({ sub: 'user-1', sid: 's-1', cv: 2, iat: 1, jti: 'a' });
    const rotated = jwt({ sub: 'user-1', sid: 's-1', cv: 2, iat: 9, jti: 'b' });
    expect(key(first)).toBe(key(rotated));
    expect(key(jwt({ sub: 'user-1', sid: 's-2', cv: 2 }))).not.toBe(key(first));
    expect(key(jwt({ sub: 'user-1', sid: 's-1', cv: 3 }))).not.toBe(key(first));
  });

  it('returns null for missing, empty, non-integer or malformed claims', () => {
    expect(key(jwt({ sub: 'user-1', sid: 's-1' }))).toBeNull();
    expect(key(jwt({ sub: '', sid: 's-1', cv: 1 }))).toBeNull();
    expect(key(jwt({ sub: 'user-1', sid: 's-1', cv: 1.5 }))).toBeNull();
    expect(key('not-a-jwt')).toBeNull();
    expect(key(`h.${'a'.repeat(9000)}.s`)).toBeNull();
    expect(key(`h.${encode(['array'])}.s`)).toBeNull();
    expect(() => jwtSessionKey([])).toThrow();
  });

  it('decodes base64url payloads that need padding and URL-safe characters', () => {
    const claims = { sub: 'user-ü?>', sid: 's-~~~', cv: 7 };
    const token = `h.${btoa(unescape(encodeURIComponent(JSON.stringify(claims)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
    expect(key(token)).not.toBeNull();
  });
});

describe('acceptsSessionToken', () => {
  const current = jwt({ sub: 'user-1', sid: 's-1', cv: 1 });
  const state: SessionSnapshot = { token: current, user };

  it('accepts credential rotation within the same session', () => {
    expect(acceptsSessionToken(state, jwt({ sub: 'user-1', sid: 's-1', cv: 1, jti: 'new' }), key)).toBe(true);
  });

  it('rejects a token for another session, user or credential version', () => {
    expect(acceptsSessionToken(state, jwt({ sub: 'user-1', sid: 's-2', cv: 1 }), key)).toBe(false);
    expect(acceptsSessionToken(state, jwt({ sub: 'user-2', sid: 's-1', cv: 1 }), key)).toBe(false);
    expect(acceptsSessionToken(state, jwt({ sub: 'user-1', sid: 's-1', cv: 2 }), key)).toBe(false);
    expect(acceptsSessionToken(state, 'opaque', key)).toBe(false);
  });

  it('never accepts a token while signed out', () => {
    expect(acceptsSessionToken({ token: null, user: null }, current, key)).toBe(false);
    expect(acceptsSessionToken({ token: current, user: null }, current, key)).toBe(false);
    expect(acceptsSessionToken(state, '', key)).toBe(false);
  });

  it('falls back to exact equality for unidentifiable tokens', () => {
    expect(acceptsSessionToken({ token: 'opaque', user }, 'opaque', key)).toBe(true);
    expect(acceptsSessionToken({ token: 'opaque', user }, 'other', key)).toBe(false);
  });
});

describe('createSessionRequestScope', () => {
  function store(initial: SessionSnapshot) {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      read: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      set(next: SessionSnapshot) { state = next; listeners.forEach(listener => listener()); },
      listeners,
    };
  }

  it('keeps requests alive across token rotation and aborts them when the session changes', () => {
    const s = store({ token: jwt({ sub: 'user-1', sid: 's-1', cv: 1 }), user });
    const scope = createSessionRequestScope(s.read, s.subscribe, key);
    const first = scope.signal();
    s.set({ token: jwt({ sub: 'user-1', sid: 's-1', cv: 1, jti: 'rotated' }), user });
    expect(first.aborted).toBe(false);
    expect(scope.signal()).toBe(first);
    s.set({ token: jwt({ sub: 'user-2', sid: 's-9', cv: 1 }), user: { id: 'user-2' } });
    expect(first.aborted).toBe(true);
    const second = scope.signal();
    expect(second.aborted).toBe(false);
    s.set({ token: null, user: null });
    expect(second.aborted).toBe(true);
  });

  it('detects a change that happened before signal() even without a notification', () => {
    let state: SessionSnapshot = { token: jwt({ sub: 'user-1', sid: 's-1', cv: 1 }), user };
    const scope = createSessionRequestScope(() => state, () => () => {}, key);
    const first = scope.signal();
    state = { token: jwt({ sub: 'user-1', sid: 's-2', cv: 1 }), user };
    const second = scope.signal();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it('unsubscribes and aborts outstanding requests on dispose', () => {
    const s = store({ token: jwt({ sub: 'user-1', sid: 's-1', cv: 1 }), user });
    const unsubscribe = vi.fn();
    const scope = createSessionRequestScope(s.read, (listener) => { s.subscribe(listener); return unsubscribe; }, key);
    const signal = scope.signal();
    scope.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });
});

describe('sessionIdentity', () => {
  it('changes with the user or the session, not with credential rotation', () => {
    const a = sessionIdentity({ token: jwt({ sub: 'user-1', sid: 's-1', cv: 1, jti: 'x' }), user }, key);
    expect(sessionIdentity({ token: jwt({ sub: 'user-1', sid: 's-1', cv: 1, jti: 'y' }), user }, key)).toBe(a);
    expect(sessionIdentity({ token: jwt({ sub: 'user-1', sid: 's-2', cv: 1 }), user }, key)).not.toBe(a);
    expect(sessionIdentity({ token: null, user: null }, key)).not.toBe(a);
  });
});
