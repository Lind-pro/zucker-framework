import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedisClusterManager } from './cluster-manager';
import { NodeRegistry } from './node-registry';

function createFakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const kv = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const e = kv.get(key);
    if (e && Date.now() >= e.expiresAt) kv.delete(key);
    return kv.get(key);
  };
  const redis: any = {
    failHset: false,
    hashes,
    kv,
    async hset(key: string, field: string, value: string) {
      if (redis.failHset) throw new Error('redis down');
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    },
    async hget(key: string, field: string) { return hashes.get(key)?.get(field) ?? null; },
    async hdel(key: string, ...fields: string[]) {
      for (const f of fields) hashes.get(key)?.delete(f);
      return fields.length;
    },
    async hgetall(key: string) { return Object.fromEntries(hashes.get(key) ?? []); },
    async set(key: string, value: string, ...args: unknown[]) {
      const px = Number(args[args.indexOf('PX') + 1]);
      const exists = !!live(key);
      if (args.includes('NX') && exists) return null;
      if (args.includes('XX') && !exists) return null;
      kv.set(key, { value, expiresAt: Date.now() + px });
      return 'OK';
    },
    async get(key: string) { return live(key)?.value ?? null; },
    async del(...keys: string[]) { keys.forEach((k) => kv.delete(k)); return keys.length; },
    async eval(script: string, _n: number, key: string, token: string, ttl?: number) {
      const e = live(key);
      if (!e || e.value !== token) return 0;
      if (script.includes('pexpire')) e.expiresAt = Date.now() + Number(ttl);
      else kv.delete(key);
      return 1;
    },
    async scan(cursor: string, _m: string, pattern: string) {
      const prefix = pattern.replace(/\*$/, '');
      const keys = [...kv.keys()].filter((k) => k.startsWith(prefix));
      return cursor === '0' ? ['7', keys.slice(0, 1)] : ['0', keys.slice(1)];
    },
    async publish() { return 0; },
    async subscribe() {},
    async unsubscribe() {},
    on() { return redis; },
    duplicate() { return redis; },
  };
  return redis;
}

// heartbeatInterval must be < heartbeatTimeout (L2); tests that need a "paused" node stub heartbeat().
const opts = (nodeId: string) => ({ nodeId, host: 'h', port: 1, heartbeatInterval: 40, heartbeatTimeout: 50 });

describe('RedisClusterManager (regression: H3)', () => {
  const managers: RedisClusterManager[] = [];
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.onModuleDestroy();
  });
  const make = (id: string, redis: any) => {
    const m = new RedisClusterManager();
    m.configure(opts(id), redis);
    managers.push(m);
    return m;
  };

  it('heartbeat never rejects when Redis fails', async () => {
    const redis = createFakeRedis();
    const m = make('a', redis);
    await m.join();
    redis.failHset = true;
    await expect(m.heartbeat()).resolves.toBeUndefined();
  });

  it('skips corrupt entries and prunes stale members', async () => {
    const redis = createFakeRedis();
    const m = make('a', redis);
    await m.join();
    const nodes = redis.hashes.get('zucker:cluster:nodes');
    nodes.set('corrupt', '{not json');
    nodes.set('ghost', JSON.stringify({ id: 'ghost', host: 'x', port: 1, status: 'online', lastHeartbeat: new Date(0) }));
    const list = await m.getNodes();
    expect(list.map((n) => n.id)).toEqual(['a']);
    await new Promise((r) => setTimeout(r, 0));
    expect(nodes.has('ghost')).toBe(false);
  });

  it('elects exactly one leader regardless of node id order, and fails over after the lease expires', async () => {
    const redis = createFakeRedis();
    const b = make('b', redis);
    await b.join();
    const a = make('a', redis); // lower id joins later: must not become a second leader
    await a.join();
    expect(await b.isLeader()).toBe(true);
    expect(await a.isLeader()).toBe(false);
    expect((await a.getLeader())?.id).toBe('b');

    // b is paused (no heartbeat renewal); after the lease expires a takes over.
    vi.spyOn(b, 'heartbeat').mockResolvedValue(undefined);
    vi.spyOn(a, 'heartbeat').mockResolvedValue(undefined);
    await new Promise((r) => setTimeout(r, 70));
    expect(await a.isLeader()).toBe(true);
    expect(await b.isLeader()).toBe(false);
  });

  it('leave() releases the leader lease', async () => {
    const redis = createFakeRedis();
    const a = make('a', redis);
    await a.join();
    expect(await a.isLeader()).toBe(true);
    await a.leave();
    expect(redis.kv.has('zucker:cluster:leader')).toBe(false);
  });

  it('joins when configured after module init', async () => {
    const redis = createFakeRedis();
    const m = new RedisClusterManager();
    managers.push(m);
    await m.onModuleInit();
    m.configure(opts('late'), redis);
    await vi.waitFor(() => expect(m.getCurrentNode().status).toBe('online'));
    expect(redis.hashes.get('zucker:cluster:nodes')?.has('late')).toBe(true);
  });
});

describe('RedisClusterManager round 2 (L2)', () => {
  const managers: RedisClusterManager[] = [];
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.onModuleDestroy();
  });
  const make = (id: string, redis: any, extra: Record<string, unknown> = {}) => {
    const m = new RedisClusterManager();
    m.configure({ ...opts(id), ...extra }, redis);
    managers.push(m);
    return m;
  };

  it('configure throws when heartbeatInterval >= heartbeatTimeout', () => {
    const redis = createFakeRedis();
    const m = new RedisClusterManager();
    expect(() => m.configure({ nodeId: 'x', host: 'h', port: 1, heartbeatInterval: 50, heartbeatTimeout: 50 }, redis)).toThrow(/heartbeatInterval/);
    expect(() => m.configure({ nodeId: 'x', host: 'h', port: 1, heartbeatInterval: 60, heartbeatTimeout: 50 }, redis)).toThrow();
    expect(() => m.configure({ nodeId: 'x', host: 'h', port: 1, heartbeatInterval: 40, heartbeatTimeout: 50 }, redis)).not.toThrow();
  });

  it('leave() waits for an in-flight heartbeat so the node is absent afterwards', async () => {
    const redis = createFakeRedis();
    const m = make('a', redis);
    await m.join();

    // Make the next HSET (the in-flight heartbeat) slow.
    const realHset = redis.hset.bind(redis);
    let releaseHset!: () => void;
    const gate = new Promise<void>((r) => { releaseHset = r; });
    redis.hset = async (...args: unknown[]) => {
      await gate;
      return (realHset as (...a: unknown[]) => unknown)(...args);
    };
    const beat = m.heartbeat(); // blocked inside hset
    const leaving = m.leave();
    await new Promise((r) => setTimeout(r, 10));
    releaseHset();
    await Promise.all([beat, leaving]);

    expect(redis.hashes.get('zucker:cluster:nodes')?.has('a') ?? false).toBe(false);
  });

  it('a corrupt node field is HDELed', async () => {
    const redis = createFakeRedis();
    const m = make('a', redis);
    await m.join();
    const nodes = redis.hashes.get('zucker:cluster:nodes');
    nodes.set('corrupt', '{not json');
    const list = await m.getNodes();
    expect(list.map((n: { id: string }) => n.id)).toEqual(['a']);
    await new Promise((r) => setTimeout(r, 0));
    expect(nodes.has('corrupt')).toBe(false);
  });

  it('two managers with the same nodeId produce one leader', async () => {
    const redis = createFakeRedis();
    const first = make('same', redis);
    const second = make('same', redis);
    await first.join();
    await second.join();
    const leaders = [await first.isLeader(), await second.isLeader()];
    expect(leaders.filter(Boolean)).toHaveLength(1);
  });

  it('a legacy bare-id lease is resolved by getLeader()', async () => {
    const redis = createFakeRedis();
    redis.kv.set('zucker:cluster:leader', { value: 'legacy', expiresAt: Date.now() + 10_000 });
    redis.hashes.set('zucker:cluster:nodes', new Map([
      ['legacy', JSON.stringify({ id: 'legacy', host: 'old', port: 1, status: 'online', lastHeartbeat: new Date() })],
    ]));
    const m = make('b', redis, { heartbeatInterval: 4000, heartbeatTimeout: 5000 });
    await m.join();
    expect((await m.getLeader())?.id).toBe('legacy');
    expect(await m.isLeader()).toBe(false);
  });
});

describe('NodeRegistry (regression: L7)', () => {
  it('lists nodes with SCAN instead of KEYS', async () => {
    const redis = createFakeRedis();
    redis.keys = vi.fn(async () => { throw new Error('KEYS must not be used'); });
    const r1 = new NodeRegistry();
    r1.configure(redis, 'n1');
    await r1.register();
    const r2 = new NodeRegistry();
    r2.configure(redis, 'n2');
    await r2.register();
    const nodes = await r1.getAliveNodes();
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    expect(redis.keys).not.toHaveBeenCalled();
  });
});
