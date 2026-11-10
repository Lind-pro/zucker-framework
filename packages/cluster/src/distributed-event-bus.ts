import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TopicEventBus, EventHandler, Subscription, SubscriptionInfo } from '@zucker-framework/event';
import { createTopicPayload, matchesTopic } from '@zucker-framework/event';
import type { RedisLike } from './cluster-manager';

/** Wire format of a cross-node event. */
export interface DistributedEventEnvelope {
  /** Envelope version marker. */
  v: 1;
  /** Id of the publishing bus instance; receivers ignore their own messages. */
  origin: string;
  topic: string;
  payload: unknown;
  headers?: Record<string, unknown>;
}

export interface DistributedEventBusOptions {
  channelPrefix?: string;
  /** Unique id of this bus instance (default: random UUID). */
  nodeId?: string;
  /**
   * What `publish` does when the Redis publish fails. Local delivery happens
   * either way. `'throw'` (default) rejects after local delivery so the caller
   * knows other nodes were not reached; `'log'` only logs.
   */
  onRemotePublishError?: 'throw' | 'log';
}

function isEnvelope(value: unknown): value is DistributedEventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { origin?: unknown }).origin === 'string' &&
    typeof (value as { topic?: unknown }).topic === 'string'
  );
}

/**
 * 分布式事件总线
 * 基于 Redis pub/sub 扩展 TopicEventBus，实现跨节点事件传播
 *
 * 参考 jetlinks EventConnection 的跨集群事件转发设计，
 * 使用 Redis pub/sub 作为 EventConnection 的实现。
 *
 * Each event is published on `<prefix><topic>` inside an envelope that carries
 * the origin id, so the publishing node does not handle its own event twice.
 * When the Redis client supports `PSUBSCRIBE` the bus subscribes once to
 * `<prefix>*` and matches topics locally with the bus wildcard rules (`*`,
 * `**`), so wildcard subscriptions receive remote events. Without
 * `psubscribe` only exact topic subscriptions receive remote events.
 */
export class DistributedEventBus implements TopicEventBus {
  private readonly logger = new Logger(DistributedEventBus.name);
  private localHandlers = new Map<string, Set<EventHandler>>();
  private subscriber: RedisLike | null = null;
  private readonly channelPrefix: string;
  private readonly origin: string;
  private readonly onRemotePublishError: 'throw' | 'log';
  private patternSubscription: Promise<unknown> | null = null;
  /** Exact channels subscribed in the non-PSUBSCRIBE fallback. */
  private exactChannels = new Set<string>();

  constructor(
    private readonly redis: RedisLike,
    private readonly localBus: TopicEventBus,
    options: DistributedEventBusOptions = {},
  ) {
    this.channelPrefix = options.channelPrefix ?? 'zucker:events:';
    this.origin = options.nodeId ?? randomUUID();
    this.onRemotePublishError = options.onRemotePublishError ?? 'throw';
    this.setupSubscriber();
  }

  /** Id this bus stamps on outgoing envelopes. */
  get nodeId(): string {
    return this.origin;
  }

  private get usePattern(): boolean {
    return typeof this.subscriber?.psubscribe === 'function';
  }

  private setupSubscriber(): void {
    // 使用独立连接订阅（Redis pub/sub 要求）
    this.subscriber = this.redis.duplicate();
    if (this.usePattern) {
      this.subscriber.on('pmessage', (_pattern: unknown, channel: unknown, message: unknown) => {
        this.onRemoteMessage(String(channel), message);
      });
    } else {
      this.subscriber.on('message', (channel: unknown, message: unknown) => {
        this.onRemoteMessage(String(channel), message);
      });
    }
  }

  private onRemoteMessage(channel: string, message: unknown): void {
    if (!channel.startsWith(this.channelPrefix)) return;
    const channelTopic = channel.slice(this.channelPrefix.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(message));
    } catch (error) {
      this.logger.error(
        `Failed to parse event message on topic "${channelTopic}"`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    if (isEnvelope(parsed)) {
      if (parsed.origin === this.origin) return; // already delivered locally
      this.dispatchLocal(parsed.topic, parsed.payload, parsed.headers);
      return;
    }
    // Legacy message from a node running an older version: raw payload.
    this.dispatchLocal(channelTopic, parsed);
  }

  async publish(topic: string, payload: unknown, headers?: Record<string, unknown>): Promise<void> {
    if (!topic) {
      throw new Error('Topic must not be empty');
    }
    const channel = `${this.channelPrefix}${topic}`;
    const envelope: DistributedEventEnvelope = { v: 1, origin: this.origin, topic, payload };
    if (headers) envelope.headers = headers;

    // 发布到 Redis，让其他节点收到；失败不阻止本地投递
    let remoteError: unknown;
    try {
      await this.redis.publish(channel, JSON.stringify(envelope));
    } catch (err) {
      remoteError = err;
      this.logger.error(
        `Failed to publish event "${topic}" to Redis`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // 本地投递（本节点的订阅者只在此处收到一次）
    await this.localBus.publish(topic, payload, headers);

    if (remoteError !== undefined && this.onRemotePublishError === 'throw') {
      throw remoteError;
    }
  }

  subscribe(
    subscriptionOrPattern: SubscriptionInfo | string,
    handler: EventHandler,
    priority?: number,
  ): Subscription {
    if (typeof subscriptionOrPattern === 'string') {
      return this._subscribeSingle(subscriptionOrPattern, handler, priority);
    }

    // SubscriptionInfo-based subscription — propagate priority
    const sub = subscriptionOrPattern;
    const resolvedPriority = sub.priority ?? priority;
    const subscriptions: Subscription[] = [];
    for (const topic of sub.topics) {
      subscriptions.push(this._subscribeSingle(topic, handler, resolvedPriority));
    }
    return {
      unsubscribe: () => {
        for (const s of subscriptions) {
          s.unsubscribe();
        }
      },
    };
  }

  private ensureRemoteSubscription(topicPattern: string): void {
    const subscriber = this.subscriber;
    if (!subscriber) return;
    if (this.usePattern) {
      if (this.patternSubscription) return;
      const pattern = `${escapeRedisGlob(this.channelPrefix)}*`;
      this.patternSubscription = subscriber.psubscribe!(pattern).catch((err: unknown) => {
        // Allow the next subscribe() to retry.
        this.patternSubscription = null;
        this.logger.error(
          `Failed to subscribe to Redis pattern "${pattern}"`,
          err instanceof Error ? err.stack : String(err),
        );
      });
      return;
    }
    if (/(^|\/)\*\*?(\/|$)|,/.test(topicPattern)) {
      this.logger.warn(
        `Redis client has no psubscribe(); wildcard subscription "${topicPattern}" only receives local events`,
      );
    }
    const channel = `${this.channelPrefix}${topicPattern}`;
    if (this.exactChannels.has(channel)) return;
    this.exactChannels.add(channel);
    subscriber.subscribe(channel).catch((err: unknown) => {
      this.exactChannels.delete(channel);
      this.logger.error(
        `Failed to subscribe to Redis channel "${channel}"`,
        err instanceof Error ? err.stack : String(err),
      );
    });
  }

  private releaseRemoteSubscription(topicPattern: string): void {
    if (this.usePattern || !this.subscriber) return;
    const channel = `${this.channelPrefix}${topicPattern}`;
    if (!this.exactChannels.delete(channel)) return;
    this.subscriber.unsubscribe(channel).catch((err: unknown) => {
      this.logger.warn(`Failed to unsubscribe Redis channel "${channel}": ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private _subscribeSingle(
    topicPattern: string,
    handler: EventHandler,
    priority?: number,
  ): Subscription {
    // 注册本地处理器（用于远程事件分发）
    let handlers = this.localHandlers.get(topicPattern);
    if (!handlers) {
      handlers = new Set();
      this.localHandlers.set(topicPattern, handlers);
    }
    handlers.add(handler);
    this.ensureRemoteSubscription(topicPattern);

    // 同时订阅本地总线 — propagate priority
    const localSub = this.localBus.subscribe(topicPattern, handler, priority);

    return {
      unsubscribe: () => {
        localSub.unsubscribe();
        const current = this.localHandlers.get(topicPattern);
        if (current) {
          current.delete(handler);
          if (current.size === 0) {
            this.localHandlers.delete(topicPattern);
            this.releaseRemoteSubscription(topicPattern);
          }
        }
      },
    };
  }

  private dispatchLocal(
    topic: string,
    payload: unknown,
    headers?: Record<string, unknown>,
  ): void {
    const topicPayload = createTopicPayload(topic, payload, headers);
    for (const [pattern, handlers] of this.localHandlers) {
      if (matchesTopic(pattern, topic)) {
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(topicPayload)).catch((err) => {
              this.logger.error(
                `Event handler error on topic "${topic}"`,
                err instanceof Error ? err.stack : String(err),
              );
            });
          } catch (err) {
            this.logger.error(
              `Event handler error on topic "${topic}"`,
              err instanceof Error ? err.stack : String(err),
            );
          }
        });
      }
    }
  }

  /**
   * Destroy the distributed event bus — unsubscribe and release the
   * duplicated Redis subscriber connection.  Should be called on
   * module shutdown to prevent connection leaks.
   */
  async destroy(): Promise<void> {
    if (this.subscriber) {
      try {
        if (this.patternSubscription) {
          await this.subscriber.punsubscribe?.(`${escapeRedisGlob(this.channelPrefix)}*`);
        }
        if (this.exactChannels.size > 0) {
          await this.subscriber.unsubscribe(...this.exactChannels);
        }
      } catch { /* best-effort */ }
      // Close the duplicated subscriber connection
      try {
        await this.subscriber.quit?.();
      } catch { /* best-effort */ }
      this.subscriber = null;
    }
    this.patternSubscription = null;
    this.exactChannels.clear();
    this.localHandlers.clear();
  }
}

/** Escape Redis glob metacharacters so the prefix matches literally. */
function escapeRedisGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&');
}
