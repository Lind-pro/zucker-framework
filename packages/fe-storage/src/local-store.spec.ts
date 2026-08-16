import { LocalStore } from './local-store';
import { TOKEN_KEY, REFRESH_TOKEN_KEY } from './constants';

describe('LocalStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('set / get', () => {
    it('should store and retrieve a string value', () => {
      LocalStore.set('key', 'hello');
      expect(LocalStore.get('key')).toBe('hello');
    });

    it('should JSON-serialize non-string values', () => {
      LocalStore.set('obj', { a: 1 });
      expect(LocalStore.get('obj')).toEqual({ a: 1 });
    });

    it('should return null for non-existent key', () => {
      expect(LocalStore.get('missing')).toBeNull();
    });

    it('should return raw string when JSON.parse fails', () => {
      localStorage.setItem('raw', 'not-json');
      expect(LocalStore.get('raw')).toBe('not-json');
    });
  });

  describe('remove / removeAll / has / keys', () => {
    it('should remove a single key', () => {
      LocalStore.set('a', '1');
      LocalStore.remove('a');
      expect(LocalStore.has('a')).toBe(false);
    });

    it('should clear all keys with removeAll', () => {
      LocalStore.set('a', '1');
      LocalStore.set('b', '2');
      LocalStore.removeAll();
      expect(LocalStore.keys()).toHaveLength(0);
    });

    it('should report key existence with has', () => {
      expect(LocalStore.has('x')).toBe(false);
      LocalStore.set('x', '1');
      expect(LocalStore.has('x')).toBe(true);
    });

    it('should return all stored keys', () => {
      LocalStore.set('k1', 'v1');
      LocalStore.set('k2', 'v2');
      expect(LocalStore.keys().sort()).toEqual(['k1', 'k2']);
    });
  });

  describe('auth convenience methods', () => {
    it('should get/set access token', () => {
      LocalStore.setToken('my-token');
      expect(LocalStore.getToken()).toBe('my-token');
      expect(localStorage.getItem(TOKEN_KEY)).toBe('my-token');
    });

    it('should get/set refresh token', () => {
      LocalStore.setRefreshToken('refresh-123');
      expect(LocalStore.getRefreshToken()).toBe('refresh-123');
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('refresh-123');
    });

    it('should get/set user info', () => {
      const user = { id: 1, name: 'Alice' };
      LocalStore.setUserInfo(user);
      expect(LocalStore.getUserInfo()).toEqual(user);
    });

    it('should clear all auth keys', () => {
      LocalStore.setToken('t');
      LocalStore.setRefreshToken('r');
      LocalStore.setUserInfo({ id: 1 });
      LocalStore.clearAuth();
      expect(LocalStore.getToken()).toBeNull();
      expect(LocalStore.getRefreshToken()).toBeNull();
      expect(LocalStore.getUserInfo()).toBeNull();
    });
  });
});
