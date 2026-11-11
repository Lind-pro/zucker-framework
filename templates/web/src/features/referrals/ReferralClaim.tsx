'use client';
import { useEffect } from 'react';
import { useAuthHydrated } from '@/lib/site/session';
import { useAuthStore } from '@/lib/stores/auth-store';
import { failureStatus, referralApi } from './api';
import { clearReferralCode, isFinalClaimFailure, readReferralCode } from './referral-storage';

/** One claim attempt per page load at most, even if several instances mount. */
let attempted = false;

/**
 * Renders nothing. Once a session exists and a first-touch code is stored, sends it once to
 * `POST /referrals/claim`; a success or a definitive refusal clears it, transient failures keep it
 * for the next visit. The Server decides everything (eligibility, identity from the session).
 */
export function ReferralClaim() {
  const hydrated = useAuthHydrated();
  const signedIn = useAuthStore((state) => state.isAuthenticated && Boolean(state.token));
  useEffect(() => {
    if (!hydrated || !signedIn || attempted) return;
    const code = readReferralCode();
    if (!code) return;
    attempted = true;
    referralApi.claim(code).then(
      () => clearReferralCode(),
      (error: unknown) => {
        if (isFinalClaimFailure(failureStatus(error))) clearReferralCode();
      },
    );
  }, [hydrated, signedIn]);
  return null;
}
