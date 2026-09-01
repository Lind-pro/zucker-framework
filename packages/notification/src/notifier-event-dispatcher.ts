import { Logger } from '@nestjs/common';
import type { TopicEventBus } from '@zucker/event';
import type {
  Notifier,
  NotifyChannel,
  NotifyMessage,
  NotifyResult,
} from './notifier.interface';

/**
 * Notification event payload — mirrors jetlinks SerializableNotifierEvent.
 *
 * Emitted on both success and failure for tracking, auditing,
 * and integration with the event bus.
 */
export interface NotifierEvent {
  /** Whether the notification was sent successfully */
  success: boolean;
  /** Error type name on failure */
  errorType?: string;
  /** Error details on failure */
  cause?: string;
  /** Notifier instance ID */
  notifierId: string;
  /** Notification channel type */
  channel: NotifyChannel;
  /** Provider identifier */
  provider: string;
  /** Template ID if used */
  templateId?: string;
  /** Variables/context passed to the notification */
  context: Record<string, unknown>;
  /** Recipient */
  to?: string;
  /** Timestamp of the event */
  timestamp: Date;
}

/**
 * Event topic constants for notification events.
 */
export const NotifierEventTopics = {
  /** Topic for successful notification delivery */
  success: (notifierId: string) => `/notify/${notifierId}/success`,
  /** Topic for failed notification delivery */
  error: (notifierId: string) => `/notify/${notifierId}/error`,
  /** Topic for notifier config reload */
  reload: '/_sys/notifier/reload',
} as const;

/**
 * Notifier event dispatcher — mirrors jetlinks NotifierProxy + NotifierEventDispatcher.
 *
 * Wraps a Notifier instance to intercept send() calls and emit events
 * on success/failure. This enables:
 * - Notification delivery tracking via the event bus
 * - Decoupled notification history recording
 * - Integration with rule engines and automation
 *
 * The proxy delegates all identity methods (notifierId, channel, provider)
 * and close() to the underlying notifier, only intercepting send().
 */
export class NotifierEventDispatcher implements Notifier {
  private readonly logger = new Logger(NotifierEventDispatcher.name);
  private readonly target: Notifier;
  private readonly eventBus?: TopicEventBus;

  constructor(target: Notifier, eventBus?: TopicEventBus) {
    this.target = target;
    this.eventBus = eventBus;
  }

  get notifierId(): string {
    return this.target.notifierId;
  }

  get channel(): NotifyChannel {
    return this.target.channel;
  }

  get provider(): string {
    return this.target.provider;
  }

  async send(message: NotifyMessage): Promise<NotifyResult> {
    const to = Array.isArray(message.to) ? message.to.join(',') : message.to;

    try {
      const result = await this.target.send(message);

      // Emit success event
      await this.emitEvent({
        success: true,
        notifierId: this.notifierId,
        channel: this.channel,
        provider: this.provider,
        templateId: message.templateId,
        context: message.variables,
        to,
        timestamp: new Date(),
      });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Emit error event
      await this.emitEvent({
        success: false,
        errorType: error.constructor.name,
        cause: error.message,
        notifierId: this.notifierId,
        channel: this.channel,
        provider: this.provider,
        templateId: message.templateId,
        context: message.variables,
        to,
        timestamp: new Date(),
      });

      throw err;
    }
  }

  async close(): Promise<void> {
    return this.target.close();
  }

  private async emitEvent(event: NotifierEvent): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    const topic = event.success
      ? NotifierEventTopics.success(event.notifierId)
      : NotifierEventTopics.error(event.notifierId);

    try {
      await this.eventBus.publish(topic, event);
    } catch (err) {
      this.logger.warn(
        `Failed to emit notifier event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
