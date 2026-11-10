import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BusinessException } from '@zucker-framework/core';
import { type BufferSettings, DEFAULT_BUFFER_SETTINGS } from './buffer-settings';

export type FlushHandler<T> = (items: T[]) => Promise<void>;

/**
 * 持久化缓冲 — 批量写入工具
 *
 * 支持：
 * - 自动定时刷新
 * - 缓冲区满时自动刷新
 * - 挂起条目超过 maxPending 时写入文件队列（spill）或拒绝写入（reject）
 * - 失败项进入有界死信队列
 * - 可配置并行度
 *
 * 语义说明：
 * - 投递是"至少一次"：文件队列中的文件只在其条目被处理（成功或进入死信队列）后才删除，
 *   进程在两者之间崩溃会导致重启后重复投递。
 * - 多个 handler 时，某个 handler 失败重试只会从失败的 handler 开始，已成功的不会重复执行。
 * - 文件队列默认目录为 `os.tmpdir()/zucker-buffer/<name>`（name 默认为 'default'）。
 *   生产环境请通过 `fileQueueDir` 指定应用私有目录，并为每个 buffer 设置不同的 `name`。
 */
export class PersistenceBuffer<T> {
  private buffer: T[] = [];
  private deadLetterQueue: T[] = [];
  private droppedDeadLetters = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: FlushHandler<T>[] = [];
  private flushPromise: Promise<void> | null = null;
  private settings: BufferSettings;
  private fileQueueDir: string;
  private readonly maxPending: number;
  private readonly maxDeadLetterSize: number;
  private disposed = false;
  /** Optional error callback for non-fatal flush failures */
  onError?: (err: unknown) => void;

  constructor(settings?: Partial<BufferSettings>) {
    this.settings = { ...DEFAULT_BUFFER_SETTINGS, ...settings };
    const namespace = sanitizeName(this.settings.name ?? 'default');
    this.fileQueueDir =
      this.settings.fileQueueDir ?? path.join(os.tmpdir(), 'zucker-buffer', namespace);
    this.maxPending = Math.max(
      this.settings.bufferSize,
      this.settings.maxPending ?? Math.max(this.settings.bufferSize * 10, 10_000),
    );
    this.maxDeadLetterSize = Math.max(0, this.settings.maxDeadLetterSize ?? 10_000);
  }

  /**
   * 注册刷新处理器
   */
  onFlush(handler: FlushHandler<T>): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * 启动定时刷新
   */
  start(): this {
    if (this.flushTimer) return this;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        // Timer-driven flush failures are non-fatal; log and continue
        if (this.onError) this.onError(err);
      });
    }, this.settings.flushTimeoutMs);
    this.flushTimer.unref?.();
    return this;
  }

  /**
   * 停止定时刷新并刷新剩余数据。
   * 会等待正在进行的刷新完成，并持续刷新直到内存缓冲为空。
   */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    do {
      await this.flush();
    } while (this.buffer.length > 0 || this.flushPromise);
  }

  /**
   * 写入缓冲。
   * 挂起条目达到 maxPending 时：overflowPolicy='spill' 将当前内存条目写入文件队列；
   * overflowPolicy='reject' 抛出 BUFFER_FULL。
   */
  write(item: T): void {
    if (this.disposed) {
      throw new BusinessException('Buffer has been disposed', 'BUFFER_DISPOSED', 500);
    }

    if (this.buffer.length >= this.maxPending) {
      if ((this.settings.overflowPolicy ?? 'spill') === 'reject') {
        throw new BusinessException('Buffer is full', 'BUFFER_FULL', 503);
      }
      this.spillToFile(this.buffer.splice(0));
    }

    this.buffer.push(item);

    if (this.buffer.length >= this.settings.bufferSize && !this.flushPromise) {
      this.triggerFlush();
    }
  }

  private triggerFlush(): void {
    this.flush().catch((err) => {
      // Buffer-full flush failures are non-fatal; log and continue
      if (this.onError) this.onError(err);
    });
  }

  /**
   * 批量写入
   */
  writeMany(items: T[]): void {
    if (!items || items.length === 0) return;
    for (const item of items) {
      this.write(item);
    }
  }

  /**
   * 手动刷新。
   * 若已有刷新在进行，先等待其完成再刷新调用时仍在缓冲中的条目，
   * 因此 `await flush()` 返回时，调用前写入的条目已被处理（成功或进入死信队列）。
   */
  async flush(): Promise<void> {
    while (this.flushPromise) {
      await this.flushPromise.catch(() => undefined);
    }
    if (this.buffer.length === 0 && !this.hasFileQueue()) return;
    const run = this.runFlush();
    this.flushPromise = run;
    try {
      await run;
    } finally {
      if (this.flushPromise === run) this.flushPromise = null;
    }
    // 刷新期间写满的条目立即进入下一轮刷新
    if (!this.disposed && this.buffer.length >= this.settings.bufferSize && !this.flushPromise) {
      this.triggerFlush();
    }
  }

  private async runFlush(): Promise<void> {
    // 先处理文件队列中的数据（较早写入），每个文件处理完再删除
    for (const file of this.listFileQueue()) {
      const items = this.readFileQueueFile(file);
      if (items === null) continue;
      if (items.length > 0) await this.processChunk(items);
      try { fs.unlinkSync(file); } catch (err) { if (this.onError) this.onError(err); }
    }

    // 取出当前缓冲区的数据
    const items = this.buffer.splice(0);
    if (items.length === 0) return;

    // 按并行度分片处理
    const chunkSize = Math.ceil(items.length / Math.max(1, this.settings.parallelism));
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    await Promise.all(chunks.map((chunk) => this.processChunk(chunk)));
  }

  /**
   * 获取死信队列中的数据
   */
  getDeadLetterQueue(): T[] {
    return [...this.deadLetterQueue];
  }

  /**
   * 清空死信队列
   */
  clearDeadLetterQueue(): void {
    this.deadLetterQueue = [];
  }

  /** 因死信队列超过 maxDeadLetterSize 而被丢弃的条目数 */
  get droppedDeadLetterCount(): number {
    return this.droppedDeadLetters;
  }

  /**
   * 获取当前缓冲区大小
   */
  get size(): number {
    return this.buffer.length;
  }

  private async processChunk(items: T[]): Promise<void> {
    let retries = 0;
    // 已成功的 handler 不在重试时重复执行
    let nextHandler = 0;
    while (retries <= this.settings.maxRetries) {
      try {
        for (; nextHandler < this.handlers.length; nextHandler++) {
          await this.handlers[nextHandler](items);
        }
        return;
      } catch (err) {
        retries++;
        const shouldRetry = this.settings.retryWhenError?.(err) ?? false;
        if (!shouldRetry || retries > this.settings.maxRetries) {
          // 超过重试次数，放入死信队列
          if (this.onError) this.onError(err);
          this.pushDeadLetters(items);
          return;
        }
        // 指数退避等待
        await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, retries), 5000)));
      }
    }
  }

  private pushDeadLetters(items: T[]): void {
    this.deadLetterQueue.push(...items);
    const overflow = this.deadLetterQueue.length - this.maxDeadLetterSize;
    if (overflow > 0) {
      this.deadLetterQueue.splice(0, overflow);
      this.droppedDeadLetters += overflow;
    }
  }

  /**
   * 将数据写入文件队列（内存溢出保护）。
   * 先写临时文件再重命名，避免读取到半写入的文件。
   */
  spillToFile(items: T[]): void {
    if (!items || items.length === 0) return;
    try {
      fs.mkdirSync(this.fileQueueDir, { recursive: true, mode: 0o700 });
      const base = `buffer-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const tmp = path.join(this.fileQueueDir, `${base}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.fileQueueDir, `${base}.json`));
    } catch (err) {
      // 文件写入失败，放入死信队列
      if (this.onError) this.onError(err);
      this.pushDeadLetters(items);
    }
  }

  private hasFileQueue(): boolean {
    return this.listFileQueue().length > 0;
  }

  private listFileQueue(): string[] {
    try {
      if (!fs.existsSync(this.fileQueueDir)) return [];
      return fs
        .readdirSync(this.fileQueueDir)
        .filter((f) => f.startsWith('buffer-') && f.endsWith('.json'))
        .sort()
        .map((f) => path.join(this.fileQueueDir, f));
    } catch (dirErr) {
      if (this.onError) this.onError(dirErr);
      return [];
    }
  }

  /** 读取文件队列文件；损坏的文件会被删除并返回 null */
  private readFileQueueFile(filePath: string): T[] | null {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Array.isArray(data) ? (data as T[]) : [];
    } catch (parseErr) {
      if (this.onError) this.onError(parseErr);
      try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
      return null;
    }
  }
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'default';
}
