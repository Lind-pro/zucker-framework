'use client';
import { useEffect } from 'react';
import { captureReferralCode } from './referral-storage';

/** Renders nothing; records the first-touch `?ref=` code of a visit in the browser. */
export function ReferralCapture() {
  useEffect(() => captureReferralCode(window.location.search), []);
  return null;
}
