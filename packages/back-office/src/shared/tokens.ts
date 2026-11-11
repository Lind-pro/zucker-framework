/** The hosts published as subpaths of `@zucker-framework/back-office`. */
export const BACK_OFFICE_HOSTS = ['accounts', 'subscriptions', 'billing', 'management', 'mail', 'settings'] as const;
export type BackOfficeHost = (typeof BACK_OFFICE_HOSTS)[number];

const TOKEN_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Injection token for a back-office host provider: `Symbol.for('zucker:back-office:<host>:<name>')`.
 *
 * Registered symbols (not `Symbol()`) are deliberate: the package ships separate CJS and ESM entries
 * per subpath, and shared code is inlined into each of them. A registered symbol is the same value in
 * every copy, so a token exported from `/accounts` still matches when `/billing` injects it.
 */
export function backOfficeToken(host: BackOfficeHost, name: string): symbol {
  if (!(BACK_OFFICE_HOSTS as readonly string[]).includes(host)) {
    throw new TypeError(`[back-office] unknown host "${String(host)}"`);
  }
  if (typeof name !== 'string' || !TOKEN_NAME.test(name)) {
    throw new TypeError(`[back-office] token name must be alphanumeric camelCase, got "${String(name)}"`);
  }
  return Symbol.for(`zucker:back-office:${host}:${name}`);
}
