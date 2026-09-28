export interface CookieOptions {
  path?: string;
  domain?: string;
  expires?: Date;
  /** Lifetime in seconds, not milliseconds. */
  maxAge?: number;
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
}

function validateName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new TypeError('Invalid cookie name');
  }
}

/** Browser-readable cookies only. HttpOnly credentials must be set by a server. */
export function setCookie(name: string, value: string, options: CookieOptions = {}): void {
  validateName(name);
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path !== undefined) {
    if (!options.path.startsWith('/') || /[;\x00-\x1f\x7f]/.test(options.path)) {
      throw new TypeError('Invalid cookie path');
    }
    parts.push(`Path=${options.path}`);
  }
  if (options.domain !== undefined) {
    if (!/^\.?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(options.domain)) {
      throw new TypeError('Invalid cookie domain');
    }
    parts.push(`Domain=${options.domain}`);
  }
  if (options.expires !== undefined) {
    if (!Number.isFinite(options.expires.getTime())) throw new TypeError('Invalid cookie expiry');
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.maxAge !== undefined) {
    if (!Number.isSafeInteger(options.maxAge)) throw new TypeError('Invalid cookie max age');
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.sameSite !== undefined) {
    if (!['Strict', 'Lax', 'None'].includes(options.sameSite)) throw new TypeError('Invalid cookie SameSite');
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) parts.push('Secure');
  if (typeof document !== 'undefined') document.cookie = parts.join('; ');
}

/** Exact-name lookup; malformed percent encoding is retained as a legacy raw value. */
export function getCookie(name: string): string | null {
  validateName(name);
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const entry of document.cookie.split(';')) {
    const cookie = entry.trimStart();
    if (!cookie.startsWith(prefix)) continue;
    const value = cookie.slice(prefix.length);
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

/** Deletion must use the same path/domain as the original cookie. */
export function removeCookie(name: string, options: Omit<CookieOptions, 'expires' | 'maxAge'> = {}): void {
  setCookie(name, '', { ...options, expires: new Date(0), maxAge: 0 });
}
