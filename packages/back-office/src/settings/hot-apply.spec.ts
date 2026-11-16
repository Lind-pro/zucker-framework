// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HotProvider } from './hot-apply';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const build = deferred<{ id: string }>(), dispose = vi.fn();
  const hot = HotProvider.create(undefined, {}, { name: 'Synthetic middleware', profiles: ['synthetic'], build: () => build.promise, dispose });
  return { hot, build, dispose };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('HotProvider middleware response lifecycle', () => {
  it('releases the acquired lease when the response closes during acquisition and never calls downstream', async () => {
    const f = fixture(), response = new EventEmitter(), next = vi.fn();
    f.hot.middleware()({}, response, next);
    response.emit('close');
    f.build.resolve({ id: 'provider' });
    await settle();
    await f.hot.close();
    expect(next).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });
  it.each(['closed', 'destroyed'] as const)('does not acquire for a response already %s', async field => {
    const f = fixture(), response = Object.assign(new EventEmitter(), { [field]: true }), next = vi.fn();
    const acquire = vi.spyOn(f.hot.slot, 'use');
    f.hot.middleware()({}, response, next);
    await settle();
    expect(acquire).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    await f.hot.close();
  });
  it('holds a streaming response lease until close, including while the provider closes', async () => {
    const f = fixture(), response = new EventEmitter(), next = vi.fn();
    f.build.resolve({ id: 'stream-provider' });
    await f.hot.ready();
    f.hot.middleware()({}, response, next);
    await settle();
    expect(next).toHaveBeenCalledTimes(1);
    await f.hot.close();
    expect(f.dispose).not.toHaveBeenCalled();
    response.emit('close');
    await settle();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });
  it('does not report provider failure to a response that disconnected during acquisition', async () => {
    const f = fixture(), response = new EventEmitter(), next = vi.fn();
    f.hot.middleware()({}, response, next);
    response.emit('close');
    f.build.reject(new Error('synthetic assembly failure'));
    await settle();
    expect(next).not.toHaveBeenCalled();
    expect(response.listenerCount('close')).toBe(0);
    await f.hot.close();
  });
  it('forwards a synchronous downstream error and releases its lease without waiting for close', async () => {
    const f = fixture(), response = new EventEmitter(), failure = new Error('downstream failed');
    const next = vi.fn((error?: unknown) => { if (!error) throw failure; });
    f.build.resolve({ id: 'provider' });
    f.hot.middleware()({}, response, next);
    await settle();
    await f.hot.close();
    expect(next).toHaveBeenNthCalledWith(2, failure);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });
});
