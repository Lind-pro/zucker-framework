import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

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
  /**
   * A node whose last heartbeat is older than this is reported `offline`.
   * Also the leader lease duration (default: 30000).
   */
  heartbeatTimeout?: number;
  /**
   * Membership entries whose last heartbeat is older than this are removed
   * from the shared node hash by any member (default: 10 × heartbeatTimeout).
   */
  staleNodeTimeout?: number;
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

/** Compare-and-pexpire used to renew the leader lease. */
export const RENEW_LEADER_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Compare-and-delete used to give up the leader lease. */
export const RELEASE_LEADER_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function defaultNodeId(): string {
  return `node_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/**
 * Redis-based cluster manager.
 *
 * Membership: one Redis hash (`<prefix>nodes`) updated by a heartbeat. Entries
 * older than `staleNodeTimeout` are pruned by whichever member reads the list;
 * unparsable entries are skipped.
 *
 * Leadership: a Redis lease (`<prefix>leader`, `SET NX PX heartbeatTimeout`)
 * renewed on each heartbeat with a compare-and-pexpire. At most one node holds
 * the lease at a time; a paused or crashed leader loses it after
 * `heartbeatTimeout`. Leadership is still advisory (there is no fencing
 * token), so work that must never overlap should also take a
 * {@link RedisDistributedLock}.
 *
 * Configuration may happen after module init: `configure()` joins
 * automatically once the module has started.
 */
@Injectable()
export class RedisClusterManager implements ClusterManager, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClusterManager.name);
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private joined = false;
  private initialized = false;
  private heartbeatRunning?: Promise<void>;
  /**
   * Value stored in the leader lease: node id plus a per-process random suffix, so two processes
   * misconfigured with the same `nodeId` cannot both consider themselves leader.
   */
  private readonly leaseSuffix = randomBytes(6).toString('hex');

  private options: Required<ClusterManagerOptions>;
  private redis: RedisLike | null = null;

  constructor() {
    this.options = {
      nodeId: defaultNodeId(),
      host: 'localhost',
      port: 3000,
      heartbeatInterval: 10000,
      heartbeatTimeout: 30000,
      staleNodeTimeout: 300000,
      redisPrefix: 'zucker:cluster:',
    };
  }

  configure(options: ClusterManagerOptions, redis: RedisLike): void {
    const heartbeatTimeout = options.heartbeatTimeout ?? 30000;
    const heartbeatInterval = options.heartbeatInterval ?? 10000;
    if (!(heartbeatInterval > 0) || !(heartbeatTimeout > heartbeatInterval)) {
      // The leader lease (heartbeatTimeout) is renewed once per heartbeat: with interval >= timeout
      // it lapses between heartbeats and leadership flaps.
      throw new Error(
        `Cluster heartbeatInterval (${heartbeatInterval}ms) must be positive and less than heartbeatTimeout (${heartbeatTimeout}ms)`,
      );
    }
    this.options = {
      ...options,
      heartbeatInterval,
      redisPrefix: options.redisPrefix ?? 'zucker:cluster:',
      nodeId: options.nodeId || defaultNodeId(),
      heartbeatTimeout,
      staleNodeTimeout: options.staleNodeTimeout ?? heartbeatTimeout * 10,
    };
    this.redis = redis;
    if (this.initialized && !this.joined) {
      this.join().catch((err: unknown) => {
        this.logger.error(`Failed to join cluster: ${errorMessage(err)}`);
      });
    }
  }

  async onModuleInit(): Promise<void> {
    this.initialized = true;
    if (this.redis) {
      await this.join();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.leave();
  }

  private get nodesKey(): string {
    return `${this.options.redisPrefix}nodes`;
  }

  private get leaderKey(): string {
    return `${this.options.redisPrefix}leader`;
  }

  private get leaseValue(): string {
    return `${this.options.nodeId}#${this.leaseSuffix}`;
  }

  /** Node id from a lease value (values written by 1.0.18 nodes are the bare node id). */
  private static leaseNodeId(value: string): string {
    const i = value.lastIndexOf('#');
    return i > 0 ? value.slice(0, i) : value;
  }

  async join(): Promise<void> {
    if (!this.redis || this.joined) return;

    await this.writeHeartbeat();
    this.joined = true;
    await this.refreshLeadership().catch((err: unknown) => {
      this.logger.warn(`Leader election failed: ${errorMessage(err)}`);
    });
    this.startHeartbeat();
    this.logger.log(`Node joined cluster: ${this.options.nodeId}`);
  }

  async leave(): Promise<void> {
    if (!this.redis || !this.joined) return;

    this.stopHeartbeat();
    this.joined = false;
    // An in-flight heartbeat could otherwise re-HSET this node after the HDEL below.
    await this.heartbeatRunning;
    try {
      await this.compareAndRun(this.leaderKey, RELEASE_LEADER_SCRIPT, []);
    } catch (err) {
      this.logger.warn(`Failed to release leader lease: ${errorMessage(err)}`);
    }
    await this.redis.hdel(this.nodesKey, this.options.nodeId);
    this.logger.log(`Node left cluster: ${this.options.nodeId}`);
  }

  async getNodes(): Promise<ClusterNode[]> {
    if (!this.redis) return [];

    const nodesMap = await this.redis.hgetall(this.nodesKey);
    const nodes: ClusterNode[] = [];
    const stale: string[] = [];
    const now = Date.now();

    for (const [field, value] of Object.entries(nodesMap ?? {})) {
      let node: ClusterNode;
      try {
        node = JSON.parse(value) as ClusterNode;
        node.lastHeartbeat = new Date(node.lastHeartbeat);
        if (!node || typeof node.id !== 'string' || Number.isNaN(node.lastHeartbeat.getTime())) {
          throw new Error('invalid node entry');
        }
      } catch {
        this.logger.warn(`Removing corrupt cluster node entry: ${field}`);
        stale.push(field);
        continue;
      }

      const age = now - node.lastHeartbeat.getTime();
      if (age > this.options.staleNodeTimeout && node.id !== this.options.nodeId) {
        stale.push(field);
        continue;
      }
      // 检查心跳超时
      if (age > this.options.heartbeatTimeout) {
        node.status = 'offline';
      }

      nodes.push(node);
    }

    if (stale.length > 0) {
      this.redis.hdel(this.nodesKey, ...stale).catch((err: unknown) => {
        this.logger.warn(`Failed to prune stale or corrupt cluster nodes: ${errorMessage(err)}`);
      });
    }

    return nodes.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The node currently holding the leader lease, if it is a known member. */
  async getLeader(): Promise<ClusterNode | undefined> {
    if (!this.redis) return undefined;
    let leaderId = await this.redis.get(this.leaderKey);
    if (!leaderId && this.joined) {
      await this.refreshLeadership();
      leaderId = await this.redis.get(this.leaderKey);
    }
    if (!leaderId) return undefined;
    const leaderNodeId = RedisClusterManager.leaseNodeId(leaderId);
    const nodes = await this.getNodes();
    return nodes.find((n) => n.id === leaderNodeId);
  }

  async isLeader(): Promise<boolean> {
    if (!this.redis || !this.joined) return false;
    const leaderId = await this.redis.get(this.leaderKey);
    if (leaderId === this.leaseValue) return true;
    if (leaderId) return false;
    return this.refreshLeadership();
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

  /** Acquire the leader lease if free, or renew it if held. Returns whether this node leads. */
  private async refreshLeadership(): Promise<boolean> {
    if (!this.redis || !this.joined) return false;
    const lease = this.options.heartbeatTimeout;
    const renewed = await this.compareAndRun(this.leaderKey, RENEW_LEADER_SCRIPT, [lease]);
    if (renewed) return true;
    const acquired = await this.redis.set(this.leaderKey, this.leaseValue, 'PX', lease, 'NX');
    if (acquired) {
      this.logger.log(`Node became cluster leader: ${this.options.nodeId}`);
      return true;
    }
    return false;
  }

  private async writeHeartbeat(): Promise<void> {
    const node: ClusterNode = {
      id: this.options.nodeId,
      host: this.options.host,
      port: this.options.port,
      status: 'online',
      lastHeartbeat: new Date(),
    };
    await this.redis!.hset(this.nodesKey, this.options.nodeId, JSON.stringify(node));
  }

  /** One heartbeat tick. Never throws: a Redis outage must not crash the process. */
  async heartbeat(): Promise<void> {
    if (!this.redis || !this.joined || this.heartbeatRunning) return;
    const run = (async () => {
      try {
        await this.writeHeartbeat();
        await this.refreshLeadership();
      } catch (err) {
        this.logger.warn(`Cluster heartbeat failed: ${errorMessage(err)}`);
      }
    })();
    this.heartbeatRunning = run;
    try {
      await run;
    } finally {
      this.heartbeatRunning = undefined;
    }
  }

  private startHeartbeat(): void {
    // 防止重复创建定时器
    if (this.heartbeatTimer) this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.options.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async compareAndRun(key: string, script: string, extraArgs: number[]): Promise<boolean> {
    const redis = this.redis!;
    const me = this.leaseValue;
    if (typeof redis.eval === 'function') {
      return Number(await redis.eval(script, 1, key, me, ...extraArgs)) === 1;
    }
    // Non-atomic fallback for clients without EVAL.
    if ((await redis.get(key)) !== me) return false;
    if (script === RELEASE_LEADER_SCRIPT) {
      await redis.del(key);
    } else {
      await redis.set(key, me, 'PX', extraArgs[0], 'XX');
    }
    return true;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /** Lua scripting (ioredis signature). Required for atomic lock release/renew and leader leases. */
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** Pattern subscription (ioredis emits `pmessage`). Enables wildcard topics in DistributedEventBus. */
  psubscribe?(...patterns: string[]): Promise<unknown>;
  punsubscribe?(...patterns: string[]): Promise<unknown>;
  /** Cursor-based key iteration (ioredis signature: scan(cursor, 'MATCH', pattern, 'COUNT', n)). */
  scan?(cursor: string | number, ...args: Array<string | number>): Promise<[string, string[]]>;
}
