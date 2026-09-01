import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import type {
  Notifier,
  NotifyMessage,
  NotifyChannel,
  NotifyResult,
  SimpleNotifierProvider,
} from './notifier.interface';
import { NOTIFIER_PROVIDERS } from './notification.module';
import { NotifyHistoryService } from './notify-history.service';

export interface FallbackStrategy {
  /** Maximum retry attempts (including first attempt) */
  maxAttempts: number;
  /** Channel degradation priority, lower index = higher priority */
  channelPriority: NotifyChannel[];
  /** Delay in ms between retry attempts */
  retryDelayMs: number;
}

const DEFAULT_FALLBACK_STRATEGY: FallbackStrategy = {
  maxAttempts: 2,
  channelPriority: [
    'EMAIL' as NotifyChannel,
    'SMS' as NotifyChannel,
    'WECHAT' as NotifyChannel,
    'DINGTALK' as NotifyChannel,
    'WEBHOOK' as NotifyChannel,
    'VOICE' as NotifyChannel,
  ],
  retryDelayMs: 1000,
};

/**
 * Composite notifier service — tries the primary channel, falls back to
 * alternatives on failure. Records delivery history for tracking.
 *
 * Mirrors jetlinks CompositeNotifyConfigManager switchIfEmpty pattern.
 *
 * Supports both legacy SimpleNotifierProvider (send-only) and full
 * Notifier instances with lifecycle management.
 */
@Injectable()
export class CompositeNotifierService {
  private readonly logger = new Logger(CompositeNotifierService.name);
  private readonly providersByChannel = new Map<NotifyChannel, SimpleNotifierProvider[]>();

  constructor(
    @Inject(NOTIFIER_PROVIDERS) private readonly providers: SimpleNotifierProvider[],
    @Optional() private readonly historyService?: NotifyHistoryService,
    @Optional() private readonly strategy: FallbackStrategy = DEFAULT_FALLBACK_STRATEGY,
  ) {
    for (const provider of providers) {
      const list = this.providersByChannel.get(provider.channel) ?? [];
      list.push(provider);
      this.providersByChannel.set(provider.channel, list);
    }
  }

  /**
   * Send a notification with fallback and retry support.
   *
   * Tries the primary channel first, then degrades to alternative channels.
   * Each attempt is recorded in the history service for tracking.
   */
  async send(message: NotifyMessage): Promise<NotifyResult> {
    const orderedChannels = this.buildChannelOrder(message.channel);
    let lastError: Error | undefined;
    let attempts = 0;
    const recipients = Array.isArray(message.to) ? message.to : [message.to];

    for (const channel of orderedChannels) {
      if (attempts >= this.strategy.maxAttempts) break;

      const channelProviders = this.providersByChannel.get(channel);
      if (!channelProviders?.length) continue;

      for (const provider of channelProviders) {
        if (attempts >= this.strategy.maxAttempts) break;
        attempts++;

        // Apply retry delay for non-first attempts
        if (attempts > 1 && this.strategy.retryDelayMs > 0) {
          await this.delay(this.strategy.retryDelayMs);
        }

        try {
          const sendPromise = provider.send({ ...message, channel, to: recipients.join(',') });
          const timeoutMs = 10000; // 10秒超时
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Provider send timeout after ${timeoutMs}ms`)), timeoutMs);
          });
          try {
            await Promise.race([sendPromise, timeoutPromise]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }

          const result: NotifyResult = {
            success: true,
            timestamp: new Date(),
            channel,
            to: recipients.join(','),
          };

          this.logger.log(`Notification sent via ${channel} (attempt ${attempts})`);
          this.recordHistory(message, result, attempts);
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.logger.warn(
            `Failed to send via ${channel} (attempt ${attempts}): ${lastError.message}`,
          );

          const failResult: NotifyResult = {
            success: false,
            error: lastError.message,
            timestamp: new Date(),
            channel,
            to: recipients.join(','),
          };
          this.recordHistory(message, failResult, attempts);
        }
      }
    }

    const finalError = lastError ?? new Error(`No available provider for channel: ${message.channel}`);
    throw finalError;
  }

  /**
   * Send to multiple recipients individually, collecting results.
   * Useful for batch notifications where per-recipient tracking is needed.
   */
  async sendBatch(
    message: Omit<NotifyMessage, 'to'>,
    recipients: string[],
  ): Promise<NotifyResult[]> {
    if (!recipients || recipients.length === 0) return [];
    const results: NotifyResult[] = [];

    for (const to of recipients) {
      try {
        const result = await this.send({ ...message, to } as NotifyMessage);
        results.push(result);
      } catch (err) {
        results.push({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date(),
          channel: message.channel,
          to,
        });
      }
    }

    return results;
  }

  /**
   * Build channel order: primary channel first, then by strategy priority.
   */
  private buildChannelOrder(primaryChannel: NotifyChannel): NotifyChannel[] {
    const ordered: NotifyChannel[] = [primaryChannel];
    for (const ch of this.strategy.channelPriority) {
      if (ch !== primaryChannel) {
        ordered.push(ch);
      }
    }
    return ordered;
  }

  private recordHistory(
    message: NotifyMessage,
    result: NotifyResult,
    retryCount: number,
  ): void {
    this.historyService?.record(message, result, { retryCount });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
