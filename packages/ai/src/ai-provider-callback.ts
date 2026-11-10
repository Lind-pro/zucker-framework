import type { MediaTaskResult } from './media.interface';

/** Raw request headers as received (Node/Express style); names are matched case-insensitively. */
export type AIProviderCallbackHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** Result of an authenticated provider callback. */
export interface AIProviderCallbackVerification {
  /** The provider's task id the callback refers to (the id `generate` returned). */
  providerTaskId: string;
  /**
   * Task state parsed from the authenticated body, when the verifier can map it. Absent means
   * "authentic, but poll for the result".
   */
  task?: MediaTaskResult;
}

/**
 * Authenticates an AI provider's task callback (webhook).
 *
 * Contract:
 * - `verify` returns `null` for anything it cannot authenticate (missing/bad signature, stale or
 *   malformed timestamp, unparsable body, missing task id). It must not throw for bad input.
 * - Only a non-null result may change task state from the callback body. An unverified callback
 *   is a wake-up hint at most: the consumer may schedule one poll of the provider and must never
 *   take status or output from it.
 * - A verified callback can still be a replay inside the tolerance window; consumers settle
 *   tasks idempotently.
 * - `rawBody` is the exact received bytes (signatures are computed over them), not re-serialised
 *   JSON.
 */
export interface AIProviderCallbackVerifier {
  /** Provider id this verifier belongs to (matches `MediaProvider.id`). */
  readonly providerId: string;
  verify(
    rawBody: Uint8Array | string,
    headers: AIProviderCallbackHeaders,
  ): Promise<AIProviderCallbackVerification | null>;
  /**
   * Optional, unauthenticated: reads the provider task id a callback claims to be about, so the
   * consumer can schedule one early poll (rate-limited) when `verify` returns null. The value is
   * attacker-controlled; it must never be used for status, outputs or settlement. Returns null for
   * anything unparsable and must not throw.
   */
  hint?(rawBody: Uint8Array | string, headers: AIProviderCallbackHeaders): string | null;
}
