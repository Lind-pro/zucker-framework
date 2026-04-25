import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BusinessException } from '@zucker/core';
import { BufferSettings, DEFAULT_BUFFER_SETTINGS } from './buffer-settings';

export type FlushHandler<T> = (items: T[]) => Promise<void>;

/**
 * 持久化缓冲 — 批量写入工具
 *
 * 支持：
 * - 自动定时刷新
 * - 缓冲区满时自动刷新
 * - 内存溢出时写入文件队列
 * - 失败项进入死信队列
 * - 可配置并行度
 */
export class PersistenceBuffer<T> {
  private buffer: T[] = [];
  private deadLetterQueue: T[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: FlushHandler<T>[] = [];
  private flushing = false;
  private settings: BufferSettings;
  private fileQueueDir: string;
  private disposed = false;
  /** Optional error callback for non-fatal flush failures */
  onError?: (err: unknown) => void;

  constructor(settings?: Partial<BufferSettings>) {
    this.settings = { ...DEFAULT_BUFFER_SETTINGS, ...settings };
    this.fileQueueDir =
      this.settings.fileQueueDir ?? path.join(os.tmpdir(), 'zucker-buffer');
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
    return this;
  }

  /**
   * 停止定时刷新并刷新剩余数据
   */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * 写入缓冲
   */
  write(item: T): void {
    if (this.disposed) {
      throw new BusinessException('Buffer has been disposed', 'BUFFER_DISPOSED', 500);
    }

    this.buffer.push(item);

    if (this.buffer.length >= this.settings.bufferSize) {
      this.flush().catch((err) => {
        // Buffer-full flush failures are non-fatal; log and continue
        if (this.onError) this.onError(err);
      });
    }
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
   * 手动刷新
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    try {
      // 取出当前缓冲区的数据
      const items = this.buffer.splice(0);

      // 也加载文件队列中的数据
      const fileItems = this.loadFromFileQueue();
      const allItems = [...fileItems, ...items];

      if (allItems.length === 0) return;

      // 按并行度分片处理
      const chunkSize = Math.ceil(allItems.length / this.settings.parallelism);
      const chunks: T[][] = [];
      for (let i = 0; i < allItems.length; i += chunkSize) {
        chunks.push(allItems.slice(i, i + chunkSize));
      }

      await Promise.all(
        chunks.map((chunk) => this.processChunk(chunk)),
      );
    } finally {
      this.flushing = false;
    }
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

  /**
   * 获取当前缓冲区大小
   */
  get size(): number {
    return this.buffer.length;
  }

  private async processChunk(items: T[]): Promise<void> {
    let retries = 0;
    while (retries <= this.settings.maxRetries) {
      try {
        for (const handler of this.handlers) {
          await handler(items);
        }
        return;
      } catch (err) {
        retries++;
        const shouldRetry = this.settings.retryWhenError?.(err) ?? false;
        if (!shouldRetry || retries > this.settings.maxRetries) {
          // 超过重试次数，放入死信队列
          if (this.onError) this.onError(err);
          this.deadLetterQueue.push(...items);
          return;
        }
        // 指数退避等待
        await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, retries), 5000)));
      }
    }
  }

  /**
   * 将数据写入文件队列（内存溢出保护）
   */
  spillToFile(items: T[]): void {
    if (!items || items.length === 0) return;
    try {
      if (!fs.existsSync(this.fileQueueDir)) {
        fs.mkdirSync(this.fileQueueDir, { recursive: true });
      }
      const filename = `buffer-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      fs.writeFileSync(
        path.join(this.fileQueueDir, filename),
        JSON.stringify(items),
      );
    } catch (err) {
      // 文件写入失败，放入死信队列
      if (this.onError) this.onError(err);
      this.deadLetterQueue.push(...items);
    }
  }

  private loadFromFileQueue(): T[] {
    const items: T[] = [];
    try {
      if (!fs.existsSync(this.fileQueueDir)) return items;
      const files = fs.readdirSync(this.fileQueueDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(this.fileQueueDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (Array.isArray(data)) items.push(...data);
          fs.unlinkSync(filePath);
        } catch (parseErr) {
          // 文件损坏，删除
          if (this.onError) this.onError(parseErr);
          try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
        }
      }
    } catch (dirErr) {
      // 目录读取失败
      if (this.onError) this.onError(dirErr);
    }
    return items;
  }
}
