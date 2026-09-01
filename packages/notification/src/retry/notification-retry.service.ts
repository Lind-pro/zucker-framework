import { Injectable, Logger } from '@nestjs/common';

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30000,
};

@Injectable()
export class NotificationRetryService {
  private readonly logger = new Logger(NotificationRetryService.name);

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    policy: Partial<RetryPolicy> = {},
  ): Promise<T> {
    const p = { ...DEFAULT_RETRY_POLICY, ...policy };
    let lastError: Error | undefined;
    let delay = p.backoffMs;

    for (let attempt = 0; attempt <= p.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < p.maxRetries) {
          this.logger.warn(`Retry ${attempt + 1}/${p.maxRetries} after ${delay}ms: ${lastError.message}`);
          await this.sleep(delay);
          delay = Math.min(delay * p.backoffMultiplier, p.maxBackoffMs);
        }
      }
    }
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
