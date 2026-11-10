import type { Readable } from 'node:stream';
import type { MediaProvider } from '@zucker-framework/ai';
import type { AITaskInput, AITaskKind, AITaskOptionValue } from './types';

/**
 * Credit hold port. Every call runs on the caller's transaction (the same one that writes the task or
 * its terminal state), so a failure rolls everything back together. Implementations must be
 * idempotent for the same `operationKey` and must throw `AITaskInsufficientCreditsError` when the
 * owner cannot cover `amount`. `./adapters` maps `BatchCreditLedger` holds onto this port.
 */
export interface CreditHoldPort<Tx> {
  place(tx: Tx, input: CreditHoldPlacement): Promise<void>;
  confirm(tx: Tx, input: CreditHoldSettlement): Promise<void>;
  release(tx: Tx, input: CreditHoldSettlement & { reason: 'failed' | 'cancelled' | 'timeout' }): Promise<void>;
}

export interface CreditHoldPlacement {
  holdId: string;
  ownerId: string;
  amount: number;
  taskId: string;
  operationKey: string;
}

export interface CreditHoldSettlement {
  holdId: string;
  ownerId: string;
  taskId: string;
  operationKey: string;
}

export interface AICostQuery {
  ownerId: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  input: AITaskInput;
}

/** Server-side price in whole credits (0 allowed = free). Never taken from the client. */
export interface AICostResolver {
  resolve(query: AICostQuery): number | Promise<number>;
}

export interface AITaskOutputWrite {
  taskId: string;
  ownerId: string;
  kind: AITaskKind;
  index: number;
  body: Buffer;
  /** Sniffed from the bytes, never taken from the provider's header alone. */
  contentType: string;
  sha256: string;
  bytes: number;
  signal: AbortSignal;
}

/**
 * Streaming write of one output. The type was sniffed from the first bytes before any byte reached
 * the store; `stream` hashes and counts as it flows and errors (AITaskOutputRejectedError 'too-large')
 * once `maxBytes` is exceeded, so a store that consumes it never holds the whole output in memory.
 */
export interface AITaskOutputStreamWrite {
  taskId: string;
  ownerId: string;
  kind: AITaskKind;
  index: number;
  contentType: string;
  /** Byte cap of this output (the same one the stream enforces); stores may re-check it. */
  maxBytes: number;
  stream: Readable;
  signal: AbortSignal;
}

/** What a streaming store persisted (or already had for this (taskId, index)). */
export interface AITaskStoredObject {
  storageKey: string;
  bytes: number;
  sha256: string;
}

/**
 * Stores one verified output in the application's private storage. Must be idempotent for the same
 * (taskId, index): a retried attempt writes the same output again (or reuses the stored one).
 *
 * `putStream` (preferred) receives the output as a bounded stream. It must remove any partially
 * written object when the stream or the write fails, and may return an existing object for the same
 * (taskId, index) without consuming the stream. Throw `AITaskOutputRejectedError('quota')` for a
 * permanent storage refusal (e.g. owner quota): the task then fails and releases its hold instead of
 * retrying. Without `putStream`, `put` receives the output buffered (bounded by the same cap).
 * `./adapters` provides a buffered one on top of `@zucker-framework/storage`'s `transferVerifiedObject`.
 */
export interface OutputStorePort {
  put(output: AITaskOutputWrite): Promise<{ storageKey: string }>;
  putStream?(output: AITaskOutputStreamWrite): Promise<AITaskStoredObject>;
}

/** Structural subset of `@zucker-framework/ai`'s MediaGenerationResult used here. */
export interface AIMediaResultLike {
  url?: string;
  base64?: string;
  format?: string;
}

/** Structural subset of `@zucker-framework/ai`'s MediaTaskResult used here. */
export interface AIMediaTaskLike {
  taskId: string;
  status: string;
  progress?: number;
  result?: AIMediaResultLike;
  outputs?: readonly AIMediaResultLike[];
  error?: string;
}

/**
 * The provider surface used here: any `@zucker-framework/ai` MediaProvider / AudioGenerationProvider
 * (including HttpAsyncTaskMediaProvider and the testing FakeMediaProvider).
 */
export type AITaskMediaProvider = Pick<MediaProvider, 'id' | 'supportedTypes' | 'generate' | 'getTaskStatus'>;

export interface AITaskProviderRequest {
  taskId: string;
  ownerId: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  input: AITaskInput;
}

export interface ResolvedAITaskProvider {
  provider: AITaskMediaProvider;
  /**
   * Server-trusted provider configuration (apiKey required by MediaProvider; baseURL, resolved
   * reference URLs, callbackUrl ...). It is spread over the caller's sanitized options, so it always
   * wins; `modelId` is always the stored task model.
   */
  config: { apiKey: string } & Record<string, unknown>;
}

/** Resolves the configured provider and its credentials at execution time (never persisted). */
export interface AITaskProviderResolver {
  resolve(request: AITaskProviderRequest): ResolvedAITaskProvider | Promise<ResolvedAITaskProvider>;
}

/** Verified callback content. `outcome` is optional: a verified callback may also be only a wake-up. */
export interface VerifiedAITaskCallback {
  providerTaskId: string;
  task?: AIMediaTaskLike;
}

/**
 * Per-provider callback verifier. `@zucker-framework/ai`'s AIProviderCallbackVerifier (and its
 * HttpAsyncTaskMediaProvider.createCallbackVerifier / testing FakeCallbackVerifier) fit as is. Return
 * null when the signature or freshness check fails. `hint` may read an unverified provider task id
 * from the body; it is only used to schedule one early poll and is never trusted for results.
 */
export interface AITaskCallbackVerifier {
  verify(rawBody: Uint8Array | string, headers: Readonly<Record<string, string | string[] | undefined>>):
    VerifiedAITaskCallback | null | Promise<VerifiedAITaskCallback | null>;
  hint?(rawBody: Uint8Array | string, headers: Readonly<Record<string, string | string[] | undefined>>): string | null;
}

export interface AITaskCallbackVerifierResolver {
  resolve(providerId: string): AITaskCallbackVerifier | undefined;
}

export type { AITaskOptionValue };
