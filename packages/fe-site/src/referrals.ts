export type ReferralProvider = 'affonso' | 'promotekit';
export interface SiteReferral { provider: ReferralProvider; referralId: string }
export interface ReferralPolicy { enabledProviders?: readonly ReferralProvider[] }
export interface ReferralSource {
  cookieHeader?: string;
  globals?: { affonso_referral?: unknown; promotekit_referral?: unknown };
}
export type ReferralMetadata = Partial<Record<'affonso_referral' | 'promotekit_referral', string>>;
const names = { affonso: 'affonso_referral', promotekit: 'promotekit_referral' } as const;
function allowed(provider: unknown, policy: ReferralPolicy): provider is ReferralProvider {
  return (provider === 'affonso' || provider === 'promotekit') &&
    Array.isArray(policy.enabledProviders) && policy.enabledProviders.includes(provider);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[a-zA-Z0-9]/.test(value) && !/[^a-zA-Z0-9_.~-]/.test(value);
}
function ownValue(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, name);
  return property && 'value' in property ? property.value : undefined;
}

/** Syntax/configuration validation only. A browser referral is never authorization or proof of a sale. */
export function validateReferral(input: unknown, policy: ReferralPolicy = {}): SiteReferral | null {
  const provider = ownValue(input, 'provider'), referralId = ownValue(input, 'referralId');
  return allowed(provider, policy) && validId(referralId) ? { provider, referralId } : null;
}

/** Read official internal IDs, never raw atp/via/ref URL parameters. Conflicting sources fail closed. */
export function readReferral(provider: ReferralProvider, source: ReferralSource, policy: ReferralPolicy = {}): SiteReferral | null {
  if (!allowed(provider, policy)) return null;
  const name = names[provider];
  const header = source.cookieHeader;
  if (header !== undefined && (typeof header !== 'string' || header.length > 65536)) return null;
  const values = (header ?? '').split(';').flatMap(part => {
    const equals = part.indexOf('=');
    return equals >= 0 && part.slice(0, equals).trim() === name ? [part.slice(equals + 1).trim()] : [];
  });
  if (values.length > 1) return null;
  let cookie: string | undefined;
  const encoded = values[0];
  if (encoded !== undefined) {
    if (encoded.length > 512) return null;
    try { cookie = decodeURIComponent(encoded); } catch { return null; }
    if (!validId(cookie)) return null;
  }
  const global = ownValue(source.globals, name);
  if (global !== undefined && !validId(global)) return null;
  if (cookie !== undefined && global !== undefined && cookie !== global) return null;
  return validateReferral({ provider, referralId: cookie ?? global }, policy);
}

/** Explicit read only: no script loading, cookie writes, signup calls, PII or network activity. */
export function readBrowserReferral(provider: ReferralProvider, policy: ReferralPolicy = {}): SiteReferral | null {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !allowed(provider, policy)) return null;
  let cookieHeader: string | undefined;
  try { cookieHeader = document.cookie; } catch { /* Storage can be denied by browser policy. */ }
  const name = names[provider];
  return readReferral(provider, { cookieHeader, globals: { [name]: ownValue(window, name) } }, policy);
}

/** Server billing may merge these allowlisted keys after revalidation; arbitrary metadata is ignored. */
export function referralMetadata(input: unknown, policy: ReferralPolicy = {}): ReferralMetadata {
  const referral = validateReferral(input, policy);
  return referral ? { [names[referral.provider]]: referral.referralId } : {};
}
