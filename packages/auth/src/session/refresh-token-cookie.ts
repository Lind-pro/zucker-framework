export interface RefreshTokenCookieOptions {
  name: string;
  secure: boolean;
  maxAge: number;
  path?: string;
  domain?: string;
  sameSite?: 'lax' | 'strict' | 'none';
}

interface CookieAttributes {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  domain?: string;
}
export interface RefreshCookieResponse {
  cookie(name: string, value: string, options: CookieAttributes & { maxAge: number }): unknown;
  clearCookie(name: string, options: CookieAttributes): unknown;
}

/** Cookie transport only. Token signing, account policy and CSRF protection stay at their respective boundaries. */
export class RefreshTokenCookie {
  private readonly attributes: CookieAttributes;
  constructor(private readonly options: RefreshTokenCookieOptions) {
    if (options.sameSite === 'none' && !options.secure)
      throw new Error('SameSite=None requires a secure cookie');
    this.attributes = {
      httpOnly: true,
      secure: options.secure,
      sameSite: options.sameSite ?? 'lax',
      path: options.path ?? '/',
      ...(options.domain ? { domain: options.domain } : {}),
    };
  }
  issue(response: RefreshCookieResponse, token: string): void {
    response.cookie(this.options.name, token, { ...this.attributes, maxAge: this.options.maxAge });
  }
  clear(response: RefreshCookieResponse): void {
    response.clearCookie(this.options.name, { ...this.attributes });
  }
  read(request: { headers: { cookie?: string } }): string | null {
    for (const part of request.headers.cookie?.split(';') ?? []) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== this.options.name) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim()) || null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
