/**
 * Mailbox 消息路由 — 对标 Claude Code mailbox.ts 的 Actor 模式
 *
 * 支持 send/receive/poll 的跨模块消息传递，可用于：
 * - 审批流：发送审批请求，等待审批结果
 * - 协调器：分配任务给 worker，等待完成通知
 * - 长轮询：客户端等待特定事件
 *
 * 用法:
 * ```ts
 * const mailbox = new Mailbox<Message>();
 *
 * // 发送
 * mailbox.send({ type: 'approval', data: { orderId: '123' } });
 *
 * // 阻塞等待匹配消息
 * const approval = await mailbox.receive(msg => msg.type === 'approval');
 *
 * // 非阻塞轮询
 * const msg = mailbox.poll(msg => msg.type === 'notification');
 * ```
 */

interface Waiter<T> {
  predicate: (msg: T) => boolean;
  resolve: (msg: T) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class Mailbox<T = unknown> {
  private readonly queue: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private readonly maxQueueSize: number;

  constructor(options?: { maxQueueSize?: number }) {
    this.maxQueueSize = options?.maxQueueSize ?? 1000;
  }

  /**
   * 发送消息到邮箱
   * 如果有等待中的 receiver 匹配，直接投递（不入队）
   */
  send(message: T): void {
    // 优先投递给等待中的 receiver
    const idx = this.waiters.findIndex((w) => w.predicate(message));
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0]!;
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(message);
      return;
    }

    // 入队
    this.queue.push(message);
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift(); // 丢弃最旧的消息
    }
  }

  /**
   * 异步等待匹配的消息（阻塞直到收到或超时）
   */
  receive(
    predicate: (msg: T) => boolean = () => true,
    timeoutMs?: number,
  ): Promise<T> {
    // 先检查队列中是否已有匹配消息
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) {
      return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    }

    // 没有匹配 → 注册 waiter
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { predicate, resolve, reject };

      if (timeoutMs !== undefined) {
        waiter.timeoutHandle = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(new Error(`Mailbox receive timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * 非阻塞轮询：取出第一条匹配消息（不存在则返回 undefined）
   */
  poll(predicate: (msg: T) => boolean = () => true): T | undefined {
    const idx = this.queue.findIndex(predicate);
    if (idx === -1) return undefined;
    return this.queue.splice(idx, 1)[0];
  }

  /**
   * 查看队列中是否有匹配消息（不取出）
   */
  peek(predicate: (msg: T) => boolean = () => true): T | undefined {
    return this.queue.find(predicate);
  }

  /** 队列中的消息数量 */
  get size(): number {
    return this.queue.length;
  }

  /** 等待中的 receiver 数量 */
  get pendingReceivers(): number {
    return this.waiters.length;
  }

  /** 清空队列和所有 waiter */
  clear(): void {
    this.queue.length = 0;
    for (const waiter of this.waiters) {
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.reject(new Error('Mailbox cleared'));
    }
    this.waiters.length = 0;
  }
}
