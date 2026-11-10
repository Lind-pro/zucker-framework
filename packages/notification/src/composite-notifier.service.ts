import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import type {
  NotifyMessage,
  NotifyChannel,
  NotifyResult,
  SimpleNotifierProvider,
} from './notifier.interface';
import { NOTIFIER_PROVIDERS } from './notification.module';
import { NotifyHistoryService } from './notify-history.service';
import { notificationFailureCode } from './delivery-log';

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
    @Optional()
    @Inject(NotifyHistoryService)
    private readonly historyService?: NotifyHistoryService,
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
    let partiallyDelivered = false;

    for (const channel of orderedChannels) {
      if (attempts >= this.strategy.maxAttempts) break;
      // After part of a batch was delivered on one channel, never repeat it on another channel.
      if (partiallyDelivered && channel !== message.channel) break;

      const channelProviders = this.providersByChannel.get(channel);
      if (!channelProviders?.length) continue;

      // Addresses are channel-specific: fall back to another channel only with its own recipients.
      let pending = channel === message.channel ? message.to : message.fallbackRecipients?.[channel];
      if (pending === undefined || (Array.isArray(pending) && pending.length === 0)) continue;

      for (const provider of channelProviders) {
        if (attempts >= this.strategy.maxAttempts) break;
        attempts++;

        // Apply retry delay for non-first attempts
        if (attempts > 1 && this.strategy.retryDelayMs > 0) {
          await this.delay(this.strategy.retryDelayMs);
        }

        const to = recipientLabel(pending);
        try {
          await provider.send({ ...message, channel, to: pending });

          const result: NotifyResult = {
            success: true,
            timestamp: new Date(),
            channel,
            to,
          };

          this.logger.log(`Notification sent via ${channel} (attempt ${attempts})`);
          this.recordHistory(message, result, attempts);
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.logger.warn(
            `Notification failed: channel=${channel}, attempt=${attempts}, code=${notificationFailureCode(err)}`,
          );

          const failResult: NotifyResult = {
            success: false,
            error: lastError.message,
            timestamp: new Date(),
            channel,
            to,
          };
          this.recordHistory(message, failResult, attempts);

          // A provider that reports which recipients failed gets only those on the next attempt,
          // so recipients that already received the message are not sent it again.
          const failed = failedRecipientsOf(err);
          if (failed) {
            partiallyDelivered = true;
            pending = failed;
            if (failed.length === 0) {
              // The provider reported an error but no failed recipient: every recipient was
              // delivered, so the send succeeded and must not surface as an error.
              const delivered: NotifyResult = { success: true, timestamp: new Date(), channel, to };
              this.recordHistory(message, delivered, attempts);
              return delivered;
            }
          }
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

function recipientLabel(recipients: string | string[]): string {
  return Array.isArray(recipients) ? recipients.join(',') : recipients;
}

/** Reads `failedRecipients` from a partial-delivery error (see `PartialNotificationDeliveryError`). */
function failedRecipientsOf(error: unknown): string[] | undefined {
  if (!error || typeof error !== 'object' || !('failedRecipients' in error)) return undefined;
  const failed = (error as { failedRecipients?: unknown }).failedRecipients;
  return Array.isArray(failed) && failed.every((item) => typeof item === 'string') ? failed : undefined;
}
