// Control characters (including TAB, which WHATWG URL parsers silently strip) and
// backslashes can turn "/\t/evil.com" or "/\evil.com" into a protocol-relative URL.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const PROBE_ORIGIN = 'https://redirect-check.invalid';

/** Allow only a local absolute path for navigation after authentication. */
export function isSafeRelativeRedirect(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('/')) return false;
  if (url.startsWith('//') || url.includes('://')) return false;
  if (UNSAFE_CHARACTERS.test(url)) return false;
  // Resolve exactly as a browser would and require the target to stay on the same origin.
  try {
    return new URL(url, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}
