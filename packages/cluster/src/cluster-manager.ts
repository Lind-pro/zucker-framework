import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

export interface ClusterNode {
  id: string;
  host: string;
  port: number;
  status: 'online' | 'offline' | 'unknown';
  lastHeartbeat: Date;
  metadata?: Record<string, unknown>;
}

export interface ClusterManagerOptions {
  nodeId: string;
  host: string;
  port: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  redisPrefix?: string;
}

export interface ClusterManager {
  join(): Promise<void>;
  leave(): Promise<void>;
  getNodes(): Promise<ClusterNode[]>;
  getLeader(): Promise<ClusterNode | undefined>;
  isLeader(): Promise<boolean>;

  /**
   * 获取当前节点信息 — 对应 jetlinks ClusterManager 中获取本节点元数据的能力
   */
  getCurrentNode(): ClusterNode;
}

/**
 * Redis-based cluster manager
 * 使用 Redis Hash 存储节点信息，通过心跳机制检测节点存活
 */
@Injectable()
export class RedisClusterManager implements ClusterManager, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClusterManager.name);
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private joined = false;

  private options: Required<ClusterManagerOptions>;
  private redis: RedisLike | null = null;

  constructor() {
    this.options = {
      nodeId: `node_${Date.now()}`,
      host: 'localhost',
      port: 3000,
      heartbeatInterval: 10000,
      heartbeatTimeout: 30000,
      redisPrefix: 'zucker:cluster:',
    };
  }

  configure(options: ClusterManagerOptions, redis: RedisLike): void {
    this.options = {
      heartbeatInterval: 10000,
      heartbeatTimeout: 30000,
      redisPrefix: 'zucker:cluster:',
      ...options,
    };
    this.redis = redis;
  }

  async onModuleInit(): Promise<void> {
    if (this.redis) {
      await this.join();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.leave();
  }

  async join(): Promise<void> {
    if (!this.redis || this.joined) return;

    const node: ClusterNode = {
      id: this.options.nodeId,
      host: this.options.host,
      port: this.options.port,
      status: 'online',
      lastHeartbeat: new Date(),
    };

    await this.redis.hset(
      `${this.options.redisPrefix}nodes`,
      this.options.nodeId,
      JSON.stringify(node),
    );

    this.joined = true;
    this.startHeartbeat();
    this.logger.log(`Node joined cluster: ${this.options.nodeId}`);
  }

  async leave(): Promise<void> {
    if (!this.redis || !this.joined) return;

    this.stopHeartbeat();
    await this.redis.hdel(
      `${this.options.redisPrefix}nodes`,
      this.options.nodeId,
    );
    this.joined = false;
    this.logger.log(`Node left cluster: ${this.options.nodeId}`);
  }

  async getNodes(): Promise<ClusterNode[]> {
    if (!this.redis) return [];

    const nodesMap = await this.redis.hgetall(`${this.options.redisPrefix}nodes`);
    const nodes: ClusterNode[] = [];
    const now = Date.now();

    for (const [, value] of Object.entries(nodesMap)) {
      const node = JSON.parse(value) as ClusterNode;
      node.lastHeartbeat = new Date(node.lastHeartbeat);

      // 检查心跳超时
      if (now - node.lastHeartbeat.getTime() > this.options.heartbeatTimeout) {
        node.status = 'offline';
      }

      nodes.push(node);
    }

    return nodes.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getLeader(): Promise<ClusterNode | undefined> {
    const nodes = await this.getNodes();
    const onlineNodes = nodes.filter((n) => n.status === 'online');
    // 简单选主：ID 最小的在线节点为 leader
    return onlineNodes[0];
  }

  async isLeader(): Promise<boolean> {
    const leader = await this.getLeader();
    return leader?.id === this.options.nodeId;
  }

  getCurrentNode(): ClusterNode {
    return {
      id: this.options.nodeId,
      host: this.options.host,
      port: this.options.port,
      status: this.joined ? 'online' : 'offline',
      lastHeartbeat: new Date(),
    };
  }

  private startHeartbeat(): void {
    // 防止重复创建定时器
    if (this.heartbeatTimer) this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.redis || !this.joined) return;

      const node: ClusterNode = {
        id: this.options.nodeId,
        host: this.options.host,
        port: this.options.port,
        status: 'online',
        lastHeartbeat: new Date(),
      };

      await this.redis.hset(
        `${this.options.redisPrefix}nodes`,
        this.options.nodeId,
        JSON.stringify(node),
      );
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

/** 最小 Redis 接口（兼容 ioredis） */
export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  duplicate(): RedisLike;
  /** Gracefully close the connection (optional — present on ioredis) */
  quit?(): Promise<unknown>;
}
