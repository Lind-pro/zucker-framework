// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { BrowserPool } from './browser-pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function browser() {
  let connected = true;
  let disconnect = () => {};
  return {
    isConnected: () => connected,
    newContext: vi.fn(async (_options: { viewport?: number }) => ({ close: vi.fn(async () => {}) })),
    close: vi.fn(async () => { connected = false; disconnect(); }),
    on: (_event: 'disconnected', listener: () => void) => { disconnect = listener; },
    disconnect: () => { connected = false; disconnect(); },
  };
}

describe('BrowserPool', () => {
  it('shares launch, isolates contexts and reserves identifiers before awaits', async () => {
    const b = browser();
    const launch = vi.fn(async () => b);
    const pool = new BrowserPool(launch);
    const first = pool.createContext('a', { viewport: 1 });
    await expect(pool.createContext('a', {})).rejects.toThrow('already');
    const [a, c] = await Promise.all([first, pool.createContext('b', {})]);
    expect(a).not.toBe(c);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pool.getActiveContextCount()).toBe(2);
    await pool.shutdown();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.close).toHaveBeenCalledTimes(1);
  });
  it('retries after launch failure and recovers from disconnect', async () => {
    const b = browser(); const next = browser();
    const launch = vi.fn().mockRejectedValueOnce(new Error('launch')).mockResolvedValueOnce(b).mockResolvedValueOnce(next);
    const pool = new BrowserPool(launch);
    await expect(pool.getBrowser()).rejects.toThrow('launch');
    expect(await pool.getBrowser()).toBe(b);
    b.disconnect();
    expect(await pool.getBrowser()).toBe(next);
    await pool.shutdown();
  });
  it('shutdown waits for launch and in-flight context creation and is idempotent', async () => {
    const b = browser();
    const launching = deferred<typeof b>();
    const context = { close: vi.fn(async () => {}) };
    const creating = deferred<typeof context>();
    b.newContext.mockImplementation(() => creating.promise);
    const pool = new BrowserPool(() => launching.promise);
    const work = pool.createContext('a', {});
    const shutdown = pool.shutdown();
    expect(pool.shutdown()).toBe(shutdown);
    await expect(pool.createContext('b', {})).rejects.toThrow('shutting down');
    launching.resolve(b);
    await new Promise((r) => setImmediate(r));
    expect(b.close).not.toHaveBeenCalled();
    creating.resolve(context);
    await work; await shutdown;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });
  it('closes browser even if context close fails and reports failure', async () => {
    const b = browser();
    const pool = new BrowserPool(async () => b);
    const context = await pool.createContext('a', {});
    context.close.mockRejectedValue(new Error('close failed'));
    await expect(pool.shutdown()).rejects.toThrow('shutdown failed');
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(pool.getActiveContextCount()).toBe(0);
  });
  it('drains a bare pending launch during shutdown', async () => {
    const b = browser(); const pending = deferred<typeof b>();
    const pool = new BrowserPool(() => pending.promise);
    const getting = pool.getBrowser(); const shutdown = pool.shutdown();
    pending.resolve(b); await getting; await shutdown;
    expect(b.close).toHaveBeenCalledTimes(1);
    await expect(pool.getBrowser()).rejects.toThrow('shutting down');
  });
  it('releases reservations when context creation fails', async () => {
    const b = browser(); b.newContext.mockRejectedValueOnce(new Error('context failed'));
    const pool = new BrowserPool(async () => b);
    await expect(pool.createContext('a', {})).rejects.toThrow('context failed');
    await pool.createContext('a', {});
    expect(pool.getActiveContextCount()).toBe(1);
    await pool.shutdown();
  });
  it('coalesces concurrent context closes', async () => {
    const b = browser(); const pool = new BrowserPool(async () => b);
    const context = await pool.createContext('a', {});
    await Promise.all([pool.closeContext('a'), pool.closeContext('a')]);
    expect(context.close).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });
});
