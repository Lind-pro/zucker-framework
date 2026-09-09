import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { RedisLike } from './cluster-manager';

/**
 * 集群节点注册表 — 节点发现 + 心跳检测。
 *
 * 每个节点启动时注册自己，定期发送心跳。
 * 其他节点可以通过 getAliveNodes() 发现集群成员。
 */
export interface ClusterNodeInfo {
  nodeId: string;
  host: string;
  port: number;
  startedAt: number;
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NodeRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeRegistry.name);
  private redis: RedisLike | null = null;
  private nodeId: string = '';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly keyPrefix = 'zucker:cluster:nodes:';
  private readonly heartbeatIntervalMs = 10_000; // 10秒
  private readonly nodeTimeoutMs = 30_000; // 30秒无心跳视为离线

  configure(redis: RedisLike, nodeId: string): void {
    this.redis = redis;
    this.nodeId = nodeId;
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis || !this.nodeId) return;
    await this.register();
    this.heartbeatInterval = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    await this.deregister();
  }

  /** 注册当前节点 */
  async register(): Promise<void> {
    if (!this.redis) return;
    const info: ClusterNodeInfo = {
      nodeId: this.nodeId,
      host: process.env.HOST || 'localhost',
      port: parseInt(process.env.PORT || '4200', 10),
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    await this.redis.set(
      `${this.keyPrefix}${this.nodeId}`,
      JSON.stringify(info),
      'PX',
      this.nodeTimeoutMs,
    );
    this.logger.log(`Node registered: ${this.nodeId}`);
  }

  /** 发送心跳 */
  async heartbeat(): Promise<void> {
    if (!this.redis) return;
    try {
      const key = `${this.keyPrefix}${this.nodeId}`;
      const raw = await this.redis.get(key);
      if (raw) {
        const info = JSON.parse(raw) as ClusterNodeInfo;
        info.lastHeartbeat = Date.now();
        await this.redis.set(key, JSON.stringify(info), 'PX', this.nodeTimeoutMs);
      } else {
        await this.register();
      }
    } catch (err) {
      this.logger.warn(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 注销当前节点 */
  async deregister(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`${this.keyPrefix}${this.nodeId}`);
      this.logger.log(`Node deregistered: ${this.nodeId}`);
    } catch {
      // best-effort
    }
  }

  /** 获取所有存活节点 */
  async getAliveNodes(): Promise<ClusterNodeInfo[]> {
    if (!this.redis) return [];
    // Redis SCAN + 前缀匹配需要 keys 命令（简化实现）
    // 生产环境建议用 Redis SET 维护节点列表
    try {
      const keys = await (this.redis as any).keys?.(`${this.keyPrefix}*`) ?? [];
      const nodes: ClusterNodeInfo[] = [];
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (raw) {
          nodes.push(JSON.parse(raw) as ClusterNodeInfo);
        }
      }
      return nodes;
    } catch {
      return [];
    }
  }

  /** 获取当前节点ID */
  getNodeId(): string {
    return this.nodeId;
  }
}
