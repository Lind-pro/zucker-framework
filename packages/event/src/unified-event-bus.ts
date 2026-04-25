import { Injectable, Optional, Inject, Logger } from '@nestjs/common';
import {
  DefaultTopicEventBus,
  type TopicEventBus,
  type EventHandler,
  type Subscription,
} from './topic-event-bus';
import { TOPIC_EVENT_BUS } from './event.module';

/**
 * 集群事件传输接口
 *
 * 用于跨进程/跨节点的事件分发。
 * 本地事件走 TopicEventBus，远程事件走此接口。
 */
export interface ClusterTransport {
  /** 将事件广播到集群其他节点 */
  broadcast(topic: string, payload: unknown): Promise<void>;
  /** 订阅来自集群其他节点的事件 */
  onRemoteEvent(handler: (topic: string, payload: unknown) => void): void;
}

export const CLUSTER_TRANSPORT = Symbol('CLUSTER_TRANSPORT');

/**
 * 统一事件总线
 *
 * 对标 Claude Code 的 Hook Registry 模式：
 * 所有事件走同一个管道，通过 topic 模式匹配做路由。
 *
 * 整合了:
 * - TopicEventBus（本地发布/订阅，带 wildcard 匹配）
 * - EventEmitter2（NestJS 内置，访问日志等）
 * - ClusterTransport（可选，跨节点广播）
 *
 * 用法:
 * ```ts
 * // 发布事件（本地 + 集群）
 * await eventBus.publish('entity/user/create/after', { user });
 *
 * // 只发布到本地
 * await eventBus.publishLocal('access.log', { path, method });
 *
 * // 订阅
 * const sub = eventBus.subscribe('entity/user/**', handler);
 * sub.unsubscribe();
 * ```
 */
@Injectable()
export class UnifiedEventBus {
  private readonly logger = new Logger(UnifiedEventBus.name);
  private readonly localBus: TopicEventBus;

  constructor(
    @Inject(TOPIC_EVENT_BUS) localBus: TopicEventBus,
    @Optional() @Inject(CLUSTER_TRANSPORT) private readonly cluster?: ClusterTransport,
  ) {
    this.localBus = localBus;

    // 收到远程事件时，在本地总线上重放（不再广播回集群，避免循环）
    if (this.cluster) {
      this.cluster.onRemoteEvent((topic, payload) => {
        this.localBus.publish(topic, payload).catch((err) => {
          this.logger.error(`Failed to replay remote event [${topic}]: ${err}`);
        });
      });
    }
  }

  /**
   * 发布事件（本地 + 集群）
   * @param topic 事件主题
   * @param payload 事件负载
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    // 本地先发
    await this.localBus.publish(topic, payload);

    // 集群广播（fire-and-forget，不阻塞本地处理）
    if (this.cluster) {
      this.cluster.broadcast(topic, payload).catch((err) => {
        this.logger.warn(`Cluster broadcast failed for [${topic}]: ${err}`);
      });
    }
  }

  /**
   * 仅发布到本地（不广播到集群）
   * 适用于访问日志等高频、无需跨节点的事件
   */
  async publishLocal(topic: string, payload: unknown): Promise<void> {
    await this.localBus.publish(topic, payload);
  }

  /**
   * 订阅事件（支持 wildcard 模式）
   * @param pattern 主题匹配模式（支持 * 和 **）
   * @param handler 事件处理函数
   */
  subscribe(pattern: string, handler: EventHandler): Subscription {
    return this.localBus.subscribe(pattern, handler);
  }

  /**
   * 发布并等待所有处理完成
   * 用于需要确保所有 listener 执行完毕的场景（如事务内事件）
   */
  async publishAndWait(topic: string, payload: unknown): Promise<void> {
    await this.localBus.publish(topic, payload);
  }
}
