/**
 * 异步事件接口 — 参考 hsweb AsyncEvent / DefaultAsyncEvent
 *
 * 支持两级异步任务链：
 * - first: 优先异步任务（在 commit 前先执行）
 * - async: 普通异步任务
 *
 * 执行顺序：first 任务全部完成后，再执行 async 任务。
 * 错误会沿链传播。
 */
export interface AsyncEvent<T = unknown> {
  payload: T;
  timestamp: number;
  handled: boolean;

  markHandled(): void;

  /** 注册优先异步任务（在普通异步任务之前执行） */
  first(fn: () => Promise<void>): void;

  /** 注册普通异步任务 */
  async(fn: () => Promise<void>): void;

  /**
   * 对 first 链进行变换 — 参考 hsweb DefaultAsyncEvent.transformFirst
   *
   * 回调接收当前的 first 链 Promise，返回新的 Promise。
   * 可用于包装事务边界、添加日志等横切逻辑。
   */
  transformFirst(mapper: (current: Promise<void>) => Promise<void>): void;

  /**
   * 对 async 链进行变换 — 参考 hsweb DefaultAsyncEvent.transform
   *
   * 回调接收当前的 async 链 Promise，返回新的 Promise。
   */
  transform(mapper: (current: Promise<void>) => Promise<void>): void;

  /** 执行所有已注册任务：first 先于 async */
  getAsync(): Promise<void>;

  /** 是否有监听器注册了异步任务 */
  readonly hasListener: boolean;
}

/**
 * Create a new AsyncEvent with two-level async task chain support.
 * First tasks execute before async tasks; errors propagate along the chain.
 * @param payload - The event payload data
 * @returns A new AsyncEvent instance
 *
 * @example
 * ```ts
 * const event = createAsyncEvent({ userId: '123' });
 * event.first(async () => { /* pre-commit work *\/ });
 * event.async(async () => { /* post-commit work *\/ });
 * await event.getAsync(); // executes first, then async tasks
 * ```
 */
export function createAsyncEvent<T>(payload: T): AsyncEvent<T> {
  const firstTasks: Array<() => Promise<void>> = [];
  const asyncTasks: Array<() => Promise<void>> = [];

  let _hasListener = false;
  let _firstTransform: ((p: Promise<void>) => Promise<void>) | undefined;
  let _asyncTransform: ((p: Promise<void>) => Promise<void>) | undefined;

  const event: AsyncEvent<T> = {
    payload,
    timestamp: Date.now(),
    handled: false,

    markHandled() {
      this.handled = true;
    },

    first(fn: () => Promise<void>) {
      _hasListener = true;
      // 使用 unshift 前置插入 — 参考 hsweb DefaultAsyncEvent.first()
      // Java: this.first = publisher.then(first) — 新任务在已有链之前执行
      firstTasks.unshift(fn);
    },

    async(fn: () => Promise<void>) {
      _hasListener = true;
      asyncTasks.push(fn);
    },

    transformFirst(mapper: (current: Promise<void>) => Promise<void>) {
      _hasListener = true;
      const prev = _firstTransform;
      _firstTransform = prev
        ? (p) => mapper(prev(p))
        : mapper;
    },

    transform(mapper: (current: Promise<void>) => Promise<void>) {
      _hasListener = true;
      const prev = _asyncTransform;
      _asyncTransform = prev
        ? (p) => mapper(prev(p))
        : mapper;
    },

    get hasListener() {
      return _hasListener;
    },

    async getAsync() {
      // 构建 first 链
      let firstChain: Promise<void> = (async () => {
        for (const fn of firstTasks) {
          await fn();
        }
      })();
      if (_firstTransform) {
        firstChain = _firstTransform(firstChain);
      }
      await firstChain;

      // 构建 async 链
      let asyncChain: Promise<void> = (async () => {
        for (const fn of asyncTasks) {
          await fn();
        }
      })();
      if (_asyncTransform) {
        asyncChain = _asyncTransform(asyncChain);
      }
      await asyncChain;
    },
  };

  return event;
}
