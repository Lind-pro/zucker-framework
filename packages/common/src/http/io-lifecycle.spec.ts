import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { boundedMemoryStorage, decodeMultipartFilename } from './bounded-memory-storage';
import { createClientDisconnectAbort } from './client-disconnect-abort';
import { pLimit } from '../utils/p-limit';

const request = () => new EventEmitter() as Request;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('bounded IO lifecycles', () => {
  it('stops scheduling on failure but drains every started worker before rejecting', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started: number[] = [];
    const failure = new Error('first');
    const work = pLimit([0, 1, 2, 3], 2, async (i) => {
      started.push(i);
      if (i === 0) throw failure;
      await gate;
      throw new Error('second');
    }, { drainOnError: true });
    const settled = vi.fn();
    const observed = work.catch((error) => { settled(error); });
    await tick();
    expect(started).toEqual([0, 1]);
    expect(settled).not.toHaveBeenCalled();
    finish(); await observed;
    expect(settled).toHaveBeenCalledWith(failure);
    await expect(pLimit([], 0, async () => 1)).rejects.toThrow(RangeError);
  });
  it('immediately handles destroyed responses, preserves reason and disposes listeners', () => {
    const req = request();
    const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false }) as Response;
    const reason = new Error('请求已取消');
    const abort = createClientDisconnectAbort(req, res, { reason: () => reason });
    expect(abort.signal.reason).toBe(reason);
    abort.dispose();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    Object.defineProperty(res, 'writableEnded', { value: true });
    expect(createClientDisconnectAbort(req, res).signal.aborted).toBe(false);
  });
  it('caps aggregate bytes, drains on failure, calls back once and removes buffers', async () => {
    const storage = boundedMemoryStorage({ maxBytes: 5 });
    const req = request();
    const first = { originalname: Buffer.from('中文.pdf').toString('latin1'), stream: Readable.from([Buffer.from('123')]) };
    const cb = vi.fn();
    storage._handleFile(req, first, cb);
    await tick();
    expect(first.originalname).toBe('中文.pdf');
    expect(cb).toHaveBeenCalledWith(null, { buffer: Buffer.from('123'), size: 3 });
    const stream = new PassThrough();
    const bad = vi.fn();
    storage._handleFile(req, { originalname: 'two', stream }, bad);
    stream.write('456'); stream.emit('error', new Error('late')); stream.end('789');
    await tick();
    expect(bad).toHaveBeenCalledOnce();
    expect(bad.mock.calls[0][0].getStatus()).toBe(413);
    expect(stream.readableEnded).toBe(true);
    const file = { buffer: Buffer.from('123') };
    storage._removeFile(req, file, vi.fn());
    expect(file.buffer).toBeUndefined();
    expect(req.listenerCount('aborted')).toBe(0);
  });
  it('handles abort/early close/limit and independent requests', async () => {
    for (const event of ['aborted', 'close', 'limit']) {
      const req = request(); const stream = new PassThrough(); const cb = vi.fn();
      boundedMemoryStorage({ maxBytes: 2 })._handleFile(req, { originalname: 'a', stream }, cb);
      (event === 'aborted' ? req : stream).emit(event);
      stream.end(); await tick();
      expect(cb).toHaveBeenCalledOnce();
      expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    }
    expect(decodeMultipartFilename('中文')).toBe('中文');
    expect(decodeMultipartFilename('café')).toBe('café');
    expect(() => boundedMemoryStorage({ maxBytes: NaN })).toThrow(RangeError);
  });
});
