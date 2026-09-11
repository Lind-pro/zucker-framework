import { TOKEN_KEY, USER_KEY, REFRESH_TOKEN_KEY } from './constants';

/**
 * Wrapper around browser localStorage with JSON serialization
 * and auth-specific convenience methods.
 *
 * All methods are static so the class can be used without instantiation.
 */
export class LocalStore {
  private static attempt<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch {
      return fallback;
    }
  }
  /** Store a value under the given key. Non-string values are JSON-serialized. */
  static set(key: string, data: unknown): void {
    this.attempt(() => {
      const value = typeof data === 'string' ? data : JSON.stringify(data);
      localStorage.setItem(key, value);
    }, undefined);
  }

  /** Retrieve and JSON-parse a value by key. Returns null if the key does not exist. */
  static get<T = unknown>(key: string): T | null {
    const dataStr = this.attempt(() => localStorage.getItem(key), null);
    if (!dataStr) return null;

    try {
      return JSON.parse(dataStr) as T;
    } catch {
      return dataStr as T;
    }
  }

  /** Remove a single key from localStorage. */
  static remove(key: string): void {
    this.attempt(() => localStorage.removeItem(key), undefined);
  }

  /** Clear all keys from localStorage. */
  static removeAll(): void {
    this.attempt(() => localStorage.clear(), undefined);
  }

  /** Check whether a key exists in localStorage. */
  static has(key: string): boolean {
    return this.attempt(() => localStorage.getItem(key) !== null, false);
  }

  /** Return all keys currently stored in localStorage. */
  static keys(): string[] {
    return this.attempt(() => Object.keys(localStorage), []);
  }

  /** Retrieve the stored access token. */
  static getToken(): string | null {
    return this.get<string>(TOKEN_KEY);
  }

  /** Persist an access token. */
  static setToken(token: string): void {
    this.set(TOKEN_KEY, token);
  }

  /** Retrieve the stored refresh token. */
  static getRefreshToken(): string | null {
    return this.get<string>(REFRESH_TOKEN_KEY);
  }

  /** Persist a refresh token. */
  static setRefreshToken(token: string): void {
    this.set(REFRESH_TOKEN_KEY, token);
  }

  /** Retrieve the stored user profile object. */
  static getUserInfo<T = Record<string, unknown>>(): T | null {
    return this.get<T>(USER_KEY);
  }

  /** Persist a user profile object. */
  static setUserInfo<TUser extends object>(userInfo: TUser): void {
    this.set(USER_KEY, userInfo);
  }

  /** Remove all auth-related keys (token, refresh token, user info). */
  static clearAuth(): void {
    this.remove(TOKEN_KEY);
    this.remove(REFRESH_TOKEN_KEY);
    this.remove(USER_KEY);
  }
}
