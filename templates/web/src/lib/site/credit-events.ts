/**
 * Header and other balance views listen for this after a charge may have changed the balance
 * (task submitted, chat answer settled). Detail-free: listeners re-read `/credits/balance`.
 * Kept dependency-free so the header can listen without bundling feature code.
 */
export const CREDITS_CHANGED_EVENT = 'zucker:credits-changed';

export function announceCreditsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CREDITS_CHANGED_EVENT));
}
