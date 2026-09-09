import { Logger } from '@nestjs/common';
import { SubscribeFeature } from './subscribe.decorator';

/**
 * Event handler function that receives a TopicPayload.
 * @param payload - The topic payload containing topic, data, and headers
 */
export type EventHandler = (payload: TopicPayload) => void | Promise<void>;

/**
 * Legacy handler signature for backward compatibility.
 * Accepts raw payload and topic string.
 */
export type LegacyEventHandler = (payload: unknown, topic: string) => void | Promise<void>;

/**
 * TopicPayload — 参考 jetlinks TopicPayload
 *
 * 封装事件的 topic、payload 和 headers。
 * jetlinks 的 TopicPayload 包含 topic + Payload(ByteBuf) + headers，
 * 在 TypeScript 中简化为泛型 payload + Map headers。
 */
export interface TopicPayload<T = unknown> {
  /** The topic this event was published to */
  readonly topic: string;
  /** The event payload */
  readonly payload: T;
  /**
   * Optional headers — 参考 jetlinks TopicPayload headers
   * Used for metadata propagation (tracing, source info, etc.)
   */
  readonly headers: ReadonlyMap<string, unknown>;
}

/**
 * Create a TopicPayload instance.
 */
export function createTopicPayload<T = unknown>(
  topic: string,
  payload: T,
  headers?: Record<string, unknown> | Map<string, unknown>,
): TopicPayload<T> {
  const headerMap = headers instanceof Map
    ? headers
    : new Map(Object.entries(headers ?? {}));
  return { topic, payload, headers: headerMap };
}

/**
 * Handle returned by subscribe() — call unsubscribe() to stop receiving events.
 */
export interface Subscription {
  /** Remove this subscription and stop receiving events */
  unsubscribe: () => void;
}

/**
 * SubscriptionInfo — 参考 jetlinks Subscription (org.jetlinks.core.event.Subscription)
 *
 * 结构化订阅信息，包含：
 * - subscriberId: 订阅者标识
 * - topics: 订阅的 topic 模式列表
 * - features: 订阅特性（local/shared/broker/cluster）
 * - priority: 优先级（值越小优先级越高，与 jetlinks 一致）
 */
export interface SubscriptionInfo {
  /** Unique subscriber ID — 参考 jetlinks Subscription.subscriberId */
  subscriberId: string;
  /** Topic patterns to subscribe to (supports *, **, and comma-separated segments) */
  topics: string[];
  /** Subscription features — defaults to [LOCAL] */
  features?: SubscribeFeature[];
  /** Priority — lower value = higher priority (jetlinks convention) */
  priority?: number;
}

/**
 * Subscription builder chain — 参考 jetlinks Subscription.builder()
 */
export interface SubscriptionInfoBuilder {
  subscriberId(id: string): SubscriptionInfoBuilder;
  topics(...topics: string[]): SubscriptionInfoBuilder;
  features(...features: SubscribeFeature[]): SubscriptionInfoBuilder;
  priority(p: number): SubscriptionInfoBuilder;
  build(): SubscriptionInfo;
}

/**
 * SubscriptionInfo factory — 参考 jetlinks Subscription.builder() / Subscription.of()
 */
export const SubscriptionBuilder = {
  /**
   * Quick factory — 参考 jetlinks Subscription.of(subscriberId, topic, ...features)
   */
  of(subscriberId: string, topics: string | string[], ...features: SubscribeFeature[]): SubscriptionInfo {
    return {
      subscriberId,
      topics: Array.isArray(topics) ? topics : [topics],
      features: features.length > 0 ? features : [SubscribeFeature.LOCAL],
    };
  },

  /**
   * Builder pattern — 参考 jetlinks Subscription.builder()
   */
  builder(): SubscriptionInfoBuilder {
    const info: SubscriptionInfo = {
      subscriberId: '',
      topics: [],
      features: [SubscribeFeature.LOCAL],
    };
    return {
      subscriberId(id: string) { info.subscriberId = id; return this; },
      topics(...topics: string[]) { info.topics = topics; return this; },
      features(...features: SubscribeFeature[]) { info.features = features; return this; },
      priority(p: number) { info.priority = p; return this; },
      build() { return { ...info }; },
    };
  },
};

export interface TopicEventBus {
  /**
   * Publish an event to a topic.
   * @param topic The topic path
   * @param payload The event data
   * @param headers Optional headers for metadata propagation
   */
  publish(topic: string, payload: unknown, headers?: Record<string, unknown>): Promise<void>;

  /**
   * Subscribe using a structured SubscriptionInfo — 参考 jetlinks EventBus.subscribe(Subscription)
   */
  subscribe(subscription: SubscriptionInfo, handler: EventHandler): Subscription;

  /**
   * Subscribe with simple arguments (backward compatible).
   * @param topicPattern Topic pattern with wildcards
   * @param handler Event handler
   * @param priority Priority (lower = higher priority, default Infinity)
   */
  subscribe(
    topicPattern: string,
    handler: EventHandler | LegacyEventHandler,
    priority?: number,
  ): Subscription;
}

interface PrioritizedHandler {
  handler: EventHandler;
  priority: number;
}

/**
 * Normalize a topic pattern:
 * - Convert MQTT wildcards: # -> **, + -> *  (参考 jetlinks Subscription 构造函数)
 */
function normalizeTopic(topic: string): string {
  if (topic.includes('#') || topic.includes('+')) {
    return topic.replace(/#/g, '**').replace(/\+/g, '*');
  }
  return topic;
}

/**
 * 基于自定义 Topic 匹配的 EventBus 实现
 *
 * 支持：
 * - * (单级) 和 ** (多级) 通配符
 * - 逗号分隔的多值匹配: /device/p1/d1,d2/online
 * - MQTT 通配符自动转换: # -> **, + -> *
 * - TopicPayload 结构化消息
 * - 监听器优先级排序（值越小优先级越高，与 jetlinks 一致）
 *
 * 参考 jetlinks DefaultEventBus
 */
export class DefaultTopicEventBus implements TopicEventBus {
  private readonly logger = new Logger(DefaultTopicEventBus.name);
  private handlersByPattern = new Map<string, PrioritizedHandler[]>();

  async publish(topic: string, payload: unknown, headers?: Record<string, unknown>): Promise<void> {
    if (!topic) {
      throw new Error('Topic must not be empty');
    }
    const topicPayload = createTopicPayload(topic, payload, headers);

    // 收集匹配此 topic 的所有 pattern 下的 handler，按优先级排序后执行
    const matchingHandlers: PrioritizedHandler[] = [];

    for (const [pattern, handlers] of this.handlersByPattern) {
      if (matchesTopic(pattern, topic)) {
        matchingHandlers.push(...handlers);
      }
    }

    // 按优先级升序排列（数值小的先执行，与 jetlinks priority 语义一致）
    matchingHandlers.sort((a, b) => a.priority - b.priority);

    for (const { handler } of matchingHandlers) {
      try {
        await handler(topicPayload);
      } catch (error) {
        // 订阅者异常不应影响主流程和其他订阅者
        // 隔离单个事件处理器的错误
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Subscriber error on topic "${topic}": ${errorMsg}`,
        );
      }
    }
  }

  subscribe(
    subscriptionOrPattern: SubscriptionInfo | string,
    handler: EventHandler | LegacyEventHandler,
    priority?: number,
  ): Subscription {
    // Overload resolution
    if (typeof subscriptionOrPattern === 'string') {
      if (!subscriptionOrPattern) {
        throw new Error('Topic pattern must not be empty');
      }
      return this._subscribeSingle(
        normalizeTopic(subscriptionOrPattern),
        wrapLegacyHandler(handler),
        priority ?? Infinity,
      );
    }

    // SubscriptionInfo-based subscription
    const sub = subscriptionOrPattern;
    if (!sub.subscriberId) {
      throw new Error('SubscriptionInfo.subscriberId must not be empty');
    }
    if (!sub.topics || sub.topics.length === 0) {
      throw new Error('SubscriptionInfo.topics must not be empty');
    }
    const resolvedPriority = sub.priority ?? Infinity;
    const subscriptions: Subscription[] = [];

    for (const rawTopic of sub.topics) {
      const topic = normalizeTopic(rawTopic);
      subscriptions.push(this._subscribeSingle(topic, handler as EventHandler, resolvedPriority));
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
    priority: number,
  ): Subscription {
    const entry: PrioritizedHandler = { handler, priority };

    const handlers = this.handlersByPattern.get(topicPattern) ?? [];
    handlers.push(entry);
    this.handlersByPattern.set(topicPattern, handlers);

    return {
      unsubscribe: () => {
        const list = this.handlersByPattern.get(topicPattern);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.handlersByPattern.delete(topicPattern);
        }
      },
    };
  }

  /**
   * Remove all handlers — used during module shutdown to prevent leaks.
   */
  removeAllListeners(): void {
    this.handlersByPattern.clear();
  }
}

/**
 * Wrap a legacy handler (payload, topic) into a TopicPayload handler.
 */
function wrapLegacyHandler(handler: EventHandler | LegacyEventHandler): EventHandler {
  // If handler takes 2 params, it's a legacy handler
  if (handler.length >= 2) {
    return (msg: TopicPayload) => (handler as LegacyEventHandler)(msg.payload, msg.topic);
  }
  return handler as EventHandler;
}

/**
 * LRU cache for wildcard match results.
 * Key: "pattern\0topic", Value: boolean match result.
 * Avoids re-evaluating the same pattern/topic pair on every publish.
 */
const MATCH_CACHE_MAX_SIZE = 1024;
const matchCache = new Map<string, boolean>();

/**
 * 通配符匹配：支持 * (单级)、** (多级) 和逗号分隔的多值段
 *
 * 逗号分隔支持参考 jetlinks TopicUtils:
 * /device/p1/d1,d2/online 匹配 /device/p1/d1/online 和 /device/p1/d2/online
 */
export function matchesTopic(pattern: string, topic: string): boolean {
  if (!pattern || !topic) return false;

  const cacheKey = pattern + '\0' + topic;
  const cached = matchCache.get(cacheKey);
  if (cached !== undefined) {
    // LRU: move to end
    matchCache.delete(cacheKey);
    matchCache.set(cacheKey, cached);
    return cached;
  }

  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');
  const result = matchParts(patternParts, 0, topicParts, 0);

  // Evict oldest entry if cache is full
  if (matchCache.size >= MATCH_CACHE_MAX_SIZE) {
    const firstKey = matchCache.keys().next().value!;
    matchCache.delete(firstKey);
  }
  matchCache.set(cacheKey, result);

  return result;
}

function matchParts(
  pattern: string[], pi: number,
  topic: string[], ti: number,
): boolean {
  while (pi < pattern.length && ti < topic.length) {
    if (pattern[pi] === '**') {
      // ** 匹配零个或多个级别
      if (pi === pattern.length - 1) return true;
      for (let i = ti; i <= topic.length; i++) {
        if (matchParts(pattern, pi + 1, topic, i)) return true;
      }
      return false;
    }
    if (pattern[pi] === '*') {
      // * 匹配单级
      pi++;
      ti++;
      continue;
    }
    // 逗号分隔多值匹配 — 参考 jetlinks /device/p1/d1,d2/online
    if (pattern[pi].includes(',')) {
      const alternatives = pattern[pi].split(',');
      if (!alternatives.includes(topic[ti])) {
        return false;
      }
      pi++;
      ti++;
      continue;
    }
    if (pattern[pi] !== topic[ti]) {
      return false;
    }
    pi++;
    ti++;
  }
  // 处理末尾的 **
  while (pi < pattern.length && pattern[pi] === '**') pi++;
  return pi === pattern.length && ti === topic.length;
}
