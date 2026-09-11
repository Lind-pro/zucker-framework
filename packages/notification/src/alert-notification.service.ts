import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InMemoryNotificationDedup } from './dedup.service';
import { notificationFailureCode } from './delivery-log';

export interface AlertNotification {
  level: string;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  channels?: string[];
}
export interface FormattedAlert extends Omit<AlertNotification, 'channels'> {
  timestamp: string;
}
export interface AlertChannel {
  send(alert: FormattedAlert): Promise<void>;
}
export interface AlertNotificationOptions {
  channels: Record<string, AlertChannel>;
  defaultChannels: Record<string, readonly string[]>;
  deduplicationWindowMs: number;
  fingerprint: (alert: AlertNotification) => string;
  sanitize?: (alert: FormattedAlert) => FormattedAlert;
}
export interface AlertDeliveryResult {
  status: 'sent' | 'partial' | 'failed' | 'skipped' | 'deduplicated';
  channels: Array<{
    channel: string;
    status: 'sent' | 'failed' | 'unconfigured';
    errorCode?: string;
  }>;
}
/** Best-effort alert fan-out. A singleton owns deduplication and drains in-flight delivery at shutdown. */
@Injectable()
export class AlertNotificationService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertNotificationService.name);
  private readonly dedup: InMemoryNotificationDedup;
  private readonly active = new Set<Promise<AlertDeliveryResult>>();
  private stopped = false;
  constructor(private readonly options: AlertNotificationOptions) {
    if (!Number.isFinite(options.deduplicationWindowMs) || options.deduplicationWindowMs <= 0)
      throw new Error('Invalid alert deduplication window');
    this.dedup = new InMemoryNotificationDedup(options.deduplicationWindowMs);
  }
  async sendAlert(alert: AlertNotification): Promise<AlertDeliveryResult> {
    if (this.stopped) return { status: 'skipped', channels: [] };
    const delivery = this.deliver(alert).catch((error) => {
      this.logger.warn(`Alert delivery failed: code=${notificationFailureCode(error)}`);
      return { status: 'failed' as const, channels: [] };
    });
    this.active.add(delivery);
    try {
      return await delivery;
    } finally {
      this.active.delete(delivery);
    }
  }
  private async deliver(alert: AlertNotification): Promise<AlertDeliveryResult> {
    this.dedup.cleanup();
    const key = this.options.fingerprint(alert);
    if (this.dedup.isDuplicate(key)) return { status: 'deduplicated', channels: [] };
    const channels = [
      ...new Set(alert.channels ?? this.options.defaultChannels[alert.level] ?? []),
    ];
    const configured = channels.some((channel) => Object.hasOwn(this.options.channels, channel));
    if (!configured) {
      if (channels.length) {
        this.dedup.markSent(key);
        this.logger.warn('Alert skipped: requested channels are not configured');
      }
      return {
        status: 'skipped',
        channels: channels.map((channel) => ({ channel, status: 'unconfigured' })),
      };
    }
    let payload: FormattedAlert = {
      level: alert.level,
      title: alert.title,
      message: alert.message,
      context: alert.context,
      timestamp: new Date().toISOString(),
    };
    payload = this.options.sanitize?.(payload) ?? payload;
    // Mark before dispatch so simultaneous callers cannot flood channels. Failed attempts remain throttled.
    this.dedup.markSent(key);
    const results = await Promise.all(
      channels.map(async (channel): Promise<AlertDeliveryResult['channels'][number]> => {
        const provider = Object.hasOwn(this.options.channels, channel)
          ? this.options.channels[channel]
          : undefined;
        if (!provider) return { channel, status: 'unconfigured' };
        try {
          await provider.send(payload);
          return { channel, status: 'sent' };
        } catch (error) {
          const errorCode = notificationFailureCode(error);
          this.logger.warn(`Alert channel failed: channel=${channel}, code=${errorCode}`);
          return { channel, status: 'failed', errorCode };
        }
      }),
    );
    const sent = results.filter((result) => result.status === 'sent').length;
    const status = sent === results.length ? 'sent' : sent > 0 ? 'partial' : 'failed';
    this.logger.log(
      `Alert delivery ${status}: level=${payload.level}, channels=${results.length}, sent=${sent}`,
    );
    return { status, channels: results };
  }
  getStats() {
    return { cachedAlerts: this.dedup.size, dedupWindow: this.options.deduplicationWindowMs };
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.dedup.dispose();
    await Promise.allSettled([...this.active]);
  }
}
