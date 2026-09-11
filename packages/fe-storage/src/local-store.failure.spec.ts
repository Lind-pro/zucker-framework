import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from './local-store';

afterEach(() => vi.unstubAllGlobals());

describe('best-effort browser storage', () => {
  it('keeps SSR and unavailable storage reads empty and writes non-throwing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(LocalStore.getToken()).toBeNull();
    expect(LocalStore.has('key')).toBe(false);
    expect(LocalStore.keys()).toEqual([]);
    expect(() => LocalStore.setUserInfo({ id: 'synthetic' })).not.toThrow();
    expect(() => LocalStore.clearAuth()).not.toThrow();
  });
  it('handles quota and blocked-storage failures', () => {
    const fail = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail, clear: fail });
    expect(LocalStore.get('key')).toBeNull();
    expect(() => LocalStore.set('key', { value: 1 })).not.toThrow();
    expect(() => LocalStore.clearAuth()).not.toThrow();
  });
});
