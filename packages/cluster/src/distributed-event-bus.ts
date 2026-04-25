import { Logger } from '@nestjs/common';
import type { TopicEventBus, TopicPayload, EventHandler, Subscription, SubscriptionInfo } from '@zucker/event';
import { createTopicPayload, matchesTopic } from '@zucker/event';
import type { RedisLike } from './cluster-manager';

/**
 * 分布式事件总线
 * 基于 Redis pub/sub 扩展 TopicEventBus，实现跨节点事件传播
 *
 * 参考 jetlinks EventConnection 的跨集群事件转发设计，
 * 使用 Redis pub/sub 作为 EventConnection 的实现。
 */
export class DistributedEventBus implements TopicEventBus {
  private readonly logger = new Logger(DistributedEventBus.name);
  private localHandlers = new Map<
    string,
    Set<EventHandler>
  >();
  private subscriber: RedisLike | null = null;
  private channelPrefix: string;

  constructor(
    private readonly redis: RedisLike,
    private readonly localBus: TopicEventBus,
    options: { channelPrefix?: string } = {},
  ) {
    this.channelPrefix = options.channelPrefix ?? 'zucker:events:';
    this.setupSubscriber();
  }

  private setupSubscriber(): void {
    // 使用独立连接订阅（Redis pub/sub 要求）
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (channel: unknown, message: unknown) => {
      const channelStr = String(channel);
      const topic = channelStr.replace(this.channelPrefix, '');
      try {
        const payload = JSON.parse(String(message));
        // 分发给本地处理器
        this.dispatchLocal(topic, payload);
      } catch (error) {
        this.logger.error(
          `Failed to parse event message on topic "${topic}"`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    });
  }

  async publish(topic: string, payload: unknown, headers?: Record<string, unknown>): Promise<void> {
    if (!topic) {
      throw new Error('Topic must not be empty');
    }
    // 发布到 Redis，让所有节点都能收到
    const channel = `${this.channelPrefix}${topic}`;
    const message = headers
      ? JSON.stringify({ payload, headers })
      : JSON.stringify(payload);
    await this.redis.publish(channel, message);

    // 同时发布到本地
    await this.localBus.publish(topic, payload, headers);
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

  private _subscribeSingle(
    topicPattern: string,
    handler: EventHandler,
    priority?: number,
  ): Subscription {
    // 注册本地处理器
    if (!this.localHandlers.has(topicPattern)) {
      this.localHandlers.set(topicPattern, new Set());
      // 订阅 Redis channel
      this.subscriber?.subscribe(`${this.channelPrefix}${topicPattern}`);
    }
    this.localHandlers.get(topicPattern)!.add(handler);

    // 同时订阅本地总线 — propagate priority
    const localSub = this.localBus.subscribe(topicPattern, handler, priority);

    return {
      unsubscribe: () => {
        localSub.unsubscribe();
        const handlers = this.localHandlers.get(topicPattern);
        if (handlers) {
          handlers.delete(handler);
        }
      },
    };
  }

  private dispatchLocal(
    topic: string,
    payload: unknown,
  ): void {
    const topicPayload = createTopicPayload(topic, payload);
    for (const [pattern, handlers] of this.localHandlers) {
      if (matchesTopic(pattern, topic)) {
        handlers.forEach((handler) => {
          Promise.resolve(handler(topicPayload)).catch((err) => {
            this.logger.error(
              `Event handler error on topic "${topic}"`,
              err instanceof Error ? err.stack : String(err),
            );
          });
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
      // Unsubscribe from all channels
      const channels = [...this.localHandlers.keys()].map(
        (p) => `${this.channelPrefix}${p}`,
      );
      if (channels.length > 0) {
        try {
          await this.subscriber.unsubscribe(...channels);
        } catch { /* best-effort */ }
      }
      // Close the duplicated subscriber connection
      try {
        await this.subscriber.quit?.();
      } catch { /* best-effort */ }
      this.subscriber = null;
    }
    this.localHandlers.clear();
  }
}
