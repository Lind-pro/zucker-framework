import { httpClient } from '@/lib/http-client';
import { shellClient } from '@/lib/site/session';
import type { ReferralView } from './types';

/** Errors are explained inline by the page; never a global toast. */
const quiet = { _hideError: true } as const;

export const referralApi = {
  me: () => httpClient.get<ReferralView>('/referrals/me', undefined, quiet),
  /**
   * Background claim from the public header: the shell client refreshes an expired access token
   * like httpClient, but a rejected session only clears local state instead of redirecting to login.
   */
  claim: (code: string) => shellClient.post<{ bound: true }>('/referrals/claim', { code }, undefined, quiet),
};

/** HTTP status of a failed `httpClient` call, when known. */
export function failureStatus(error: unknown): number | undefined {
  const value = (error ?? {}) as { status?: unknown; _httpStatus?: unknown; response?: { status?: unknown } };
  for (const candidate of [value.status, value._httpStatus, value.response?.status]) if (typeof candidate === 'number') return candidate;
  return undefined;
}
