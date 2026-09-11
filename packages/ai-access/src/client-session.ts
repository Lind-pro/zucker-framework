import type { AIAccessRequest, AIAccessResult } from './contracts';

export interface AIAccessClient {
  complete(request: AIAccessRequest): Promise<AIAccessResult>;
}
export interface AIAccessInvocationObserver {
  onSuccess?: (result: AIAccessResult, startedAt: number) => Promise<void> | void;
  onFailure?: (error: unknown, startedAt: number) => Promise<void> | void;
}

/** A lazy, shared client and one observed attempt. Never retries provider work. */
export class AIAccessClientSession {
  private clientPromise?: Promise<AIAccessClient>;
  constructor(private readonly createClient: () => Promise<AIAccessClient>) {}

  async complete(
    request: AIAccessRequest,
    observer: AIAccessInvocationObserver = {},
  ): Promise<AIAccessResult> {
    const startedAt = Date.now();
    try {
      const client = await this.getClient();
      const result = await client.complete(request);
      await observer.onSuccess?.(result, startedAt);
      return result;
    } catch (error) {
      await observer.onFailure?.(error, startedAt);
      throw error;
    }
  }

  private getClient(): Promise<AIAccessClient> {
    this.clientPromise ??= this.createClient().catch((error) => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }
}
