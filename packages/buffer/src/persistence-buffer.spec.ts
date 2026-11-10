import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PersistenceBuffer } from './persistence-buffer';

let tmpDir: string;

describe('PersistenceBuffer', () => {
  let buffer: PersistenceBuffer<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zucker-buffer-spec-'));
    buffer = new PersistenceBuffer<string>({
      fileQueueDir: tmpDir,
      bufferSize: 5,
      flushTimeoutMs: 1000,
      maxRetries: 2,
      parallelism: 1,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write items to buffer and report size', () => {
    buffer.write('a');
    buffer.write('b');
    expect(buffer.size).toBe(2);
  });

  it('should flush items to handler', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.flush();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(['a', 'b']);
    expect(buffer.size).toBe(0);
  });

  it('should not flush when buffer is empty', async () => {
    const handler = vi.fn();
    buffer.onFlush(handler);
    await buffer.flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it('should auto-flush when buffer reaches bufferSize', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    // Write exactly bufferSize items (5)
    for (let i = 0; i < 5; i++) {
      buffer.write(`item-${i}`);
    }

    // Allow async flush to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(5);
  });

  it('should send failed items to dead letter queue after retries exhausted', async () => {
    const errors: unknown[] = [];
    buffer.onError = (err) => errors.push(err);
    buffer.onFlush(async () => {
      throw new Error('flush error');
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.flush();

    const dlq = buffer.getDeadLetterQueue();
    expect(dlq).toEqual(['a', 'b']);
  });

  it('should clear dead letter queue', async () => {
    buffer.onFlush(async () => {
      throw new Error('fail');
    });
    buffer.onError = () => {};

    buffer.write('a');
    await buffer.flush();

    expect(buffer.getDeadLetterQueue()).toHaveLength(1);
    buffer.clearDeadLetterQueue();
    expect(buffer.getDeadLetterQueue()).toHaveLength(0);
  });

  it('should writeMany items', () => {
    buffer.writeMany(['x', 'y', 'z']);
    expect(buffer.size).toBe(3);
  });

  it('should ignore empty writeMany', () => {
    buffer.writeMany([]);
    expect(buffer.size).toBe(0);
  });

  it('should throw when writing to disposed buffer', async () => {
    await buffer.stop();
    expect(() => buffer.write('a')).toThrow('Buffer has been disposed');
  });

  it('should flush remaining items on stop', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.stop();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(['a', 'b']);
  });

  it('should support multiple flush handlers', async () => {
    const results1: string[][] = [];
    const results2: string[][] = [];

    buffer.onFlush(async (items) => { results1.push([...items]); });
    buffer.onFlush(async (items) => { results2.push([...items]); });

    buffer.write('a');
    await buffer.flush();

    expect(results1).toHaveLength(1);
    expect(results2).toHaveLength(1);
  });

  it('should chain onFlush calls', () => {
    const result = buffer.onFlush(async () => {});
    expect(result).toBe(buffer);
  });

  it('should start and stop timer-driven flush', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.start();
    buffer.write('a');
    await vi.advanceTimersByTimeAsync(1100);

    expect(flushed.length).toBeGreaterThanOrEqual(1);
    await buffer.stop();
  });

  it('stop() waits for the in-flight flush and flushes items written meanwhile', async () => {
    vi.useRealTimers();
    const seen: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    buffer.onFlush(async (items) => {
      seen.push([...items]);
      if (first) { first = false; await gate; }
    });
    buffer.write('1');
    buffer.write('2');
    const inflight = buffer.flush();
    buffer.write('3');
    const stopping = buffer.stop();
    release();
    await inflight;
    await stopping;
    expect(seen).toEqual([['1', '2'], ['3']]);
    expect(buffer.size).toBe(0);
  });

  it('spills to the file queue when maxPending is reached and replays it later', async () => {
    vi.useRealTimers();
    const b = new PersistenceBuffer<string>({
      fileQueueDir: tmpDir, bufferSize: 2, maxPending: 2, parallelism: 1, maxRetries: 0,
    });
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    b.onFlush(async (items) => {
      if (first) { first = false; await gate; }
      seen.push(...items);
    });
    b.write('a');
    b.write('b'); // triggers flush that blocks
    b.write('c');
    b.write('d');
    b.write('e'); // pending=2 >= maxPending -> c,d spilled
    expect(b.size).toBe(1);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    release();
    await b.stop();
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('rejects writes with BUFFER_FULL under the reject policy', () => {
    const b = new PersistenceBuffer<string>({
      fileQueueDir: tmpDir, bufferSize: 2, maxPending: 3, overflowPolicy: 'reject',
    });
    b.onFlush(() => new Promise<void>(() => {})); // sink never completes
    for (let i = 0; i < 5; i++) b.write(String(i)); // 2 in flight, 3 pending
    expect(() => b.write('x')).toThrow('Buffer is full');
  });

  it('replays file-queue items even when memory is empty and keeps files until processed', async () => {
    vi.useRealTimers();
    buffer.spillToFile(['x', 'y']);
    const handler = vi.fn(async () => { throw new Error('boom'); });
    buffer.onError = () => {};
    buffer.onFlush(handler);
    await buffer.flush();
    expect(handler).toHaveBeenCalledWith(['x', 'y']);
    // non-retryable failure -> DLQ, then file removed
    expect(buffer.getDeadLetterQueue()).toEqual(['x', 'y']);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('only reads its own namespace by default', () => {
    const a = new PersistenceBuffer<string>({ name: 'alpha' });
    const b = new PersistenceBuffer<string>({ name: 'beta' });
    // @ts-expect-error private access for test
    expect(a.fileQueueDir).not.toEqual(b.fileQueueDir);
  });

  it('does not re-run handlers that already succeeded when a later handler is retried', async () => {
    vi.useRealTimers();
    const b = new PersistenceBuffer<string>({
      fileQueueDir: tmpDir, bufferSize: 10, maxRetries: 2, parallelism: 1,
      retryWhenError: () => true,
    });
    const h1 = vi.fn(async () => {});
    let calls = 0;
    const h2 = vi.fn(async () => { if (calls++ === 0) throw new Error('timeout'); });
    b.onFlush(h1).onFlush(h2);
    b.write('a');
    await b.flush();
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(2);
  });

  it('bounds the dead-letter queue', async () => {
    const b = new PersistenceBuffer<string>({
      fileQueueDir: tmpDir, bufferSize: 100, maxDeadLetterSize: 3, maxRetries: 0, parallelism: 1,
    });
    b.onError = () => {};
    b.onFlush(async () => { throw new Error('fail'); });
    b.writeMany(['1', '2', '3', '4', '5']);
    await b.flush();
    expect(b.getDeadLetterQueue()).toEqual(['3', '4', '5']);
    expect(b.droppedDeadLetterCount).toBe(2);
  });
});

describe('PersistenceBuffer file queue across instances (L4)', () => {
  let dir: string;
  const make = (extra: Record<string, unknown> = {}) =>
    new PersistenceBuffer<string>({
      fileQueueDir: dir,
      bufferSize: 1000,
      flushTimeoutMs: 100_000,
      maxRetries: 0,
      parallelism: 1,
      ...extra,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zucker-buffer-l4-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two instances on one directory deliver each spilled item once', async () => {
    const a = make();
    const b = make();
    const seenA: string[] = [];
    const seenB: string[] = [];
    a.onFlush(async (items) => { seenA.push(...items); });
    b.onFlush(async (items) => { seenB.push(...items); });
    const producer = make();
    for (let i = 0; i < 6; i++) producer.spillToFile([`item-${i}`]);

    await Promise.all([a.flush(), b.flush()]);

    const all = [...seenA, ...seenB].sort();
    expect(all).toEqual([0, 1, 2, 3, 4, 5].map((i) => `item-${i}`));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reclaims a .processing file whose owning pid is dead', async () => {
    fs.writeFileSync(path.join(dir, 'buffer-1-1-x.json.2147483646-deadbeef.processing'), JSON.stringify(['orphan']));
    const buf = make();
    const seen: string[] = [];
    buf.onFlush(async (items) => { seen.push(...items); });
    buf.write('fresh'); // gives flush() work, so the first flush runs the reclaim pass
    await buf.flush();
    expect(seen.sort()).toEqual(['fresh', 'orphan']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reclaims a .processing file of the own pid whose instance is gone', async () => {
    fs.writeFileSync(path.join(dir, `buffer-1-1-y.json.${process.pid}-deadbeef.processing`), JSON.stringify(['mine-orphan']));
    const buf = make();
    const seen: string[] = [];
    buf.onFlush(async (items) => { seen.push(...items); });
    buf.write('fresh');
    await buf.flush();
    expect(seen.sort()).toEqual(['fresh', 'mine-orphan']);
  });

  // IMPLEMENTATION BUG (low): flush() returns early when memory and the *.json queue are empty
  // (hasFileQueue ignores *.processing), so a stale claim is only reclaimed once other work arrives.
  it('reclaims a stale .processing file even when the buffer is otherwise idle', async () => {
    fs.writeFileSync(path.join(dir, 'buffer-1-1-w.json.2147483646-deadbeef.processing'), JSON.stringify(['stranded']));
    const buf = make();
    const seen: string[] = [];
    buf.onFlush(async (items) => { seen.push(...items); });
    await buf.flush();
    expect(seen).toEqual(['stranded']);
  });

  it('does not reclaim a claim held by a live instance of this process', async () => {
    const holder = make();
    // Claim files of a live instance are named with its instanceId; simulate by reading the private id.
    const id = (holder as unknown as { instanceId: string }).instanceId;
    fs.writeFileSync(path.join(dir, `buffer-1-1-z.json.${id}.processing`), JSON.stringify(['held']));
    const other = make();
    const seen: string[] = [];
    other.onFlush(async (items) => { seen.push(...items); });
    await other.flush();
    expect(seen).toEqual([]);
    expect(fs.existsSync(path.join(dir, `buffer-1-1-z.json.${id}.processing`))).toBe(true);
    await holder.stop();
  });

  it('removes an orphan .tmp file', async () => {
    const tmp = path.join(dir, 'buffer-1-2147483646-abc.tmp');
    fs.writeFileSync(tmp, '[');
    fs.writeFileSync(path.join(dir, 'buffer-2-2147483646-def.json'), JSON.stringify(['real']));
    const buf = make();
    buf.onFlush(async () => undefined);
    await buf.flush();
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('refuses a directory with mode 0777 (dead-letter queue plus onError)', () => {
    fs.chmodSync(dir, 0o777);
    const buf = make();
    const errors: unknown[] = [];
    buf.onError = (e) => errors.push(e);
    buf.spillToFile(['x', 'y']);
    expect(buf.getDeadLetterQueue()).toEqual(['x', 'y']);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/writable/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('200k dead letters do not throw', async () => {
    const buf = make({ bufferSize: 500_000, maxPending: 500_000, maxDeadLetterSize: 300_000 });
    buf.onFlush(async () => { throw new Error('always fails'); });
    buf.onError = () => undefined;
    const items = Array.from({ length: 200_000 }, (_, i) => `i${i}`);
    buf.writeMany(items);
    await expect(buf.flush()).resolves.toBeUndefined();
    expect(buf.getDeadLetterQueue()).toHaveLength(200_000);
  });
});

