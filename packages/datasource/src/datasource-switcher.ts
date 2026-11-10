import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from '@nestjs/common';

/**
 * Switcher 接口 — 对应 Java 端 Switcher，栈式切换器
 *
 * 通过 Deque (栈) 来记录切换历史，
 * useLast() 回退到上一个，use() 推入新的，reset() 清空历史。
 */
export interface Switcher {
  /** 回退到上一次使用的值 */
  useLast(): void;
  /** 使用指定值 */
  use(id: string): void;
  /** 使用默认值 */
  useDefault(): void;
  /** 获取当前值，若为默认则返回 undefined */
  current(): string | undefined;
  /** 清空切换历史 */
  reset(): void;
}

/* ---- 内部默认标记 ---- */
const DEFAULT_MARKER = '__DEFAULT__';

/**
 * DefaultSwitcher — 对应 Java 端 DefaultSwitcher
 *
 * 基于 AsyncLocalStorage 的栈式切换器，每个请求上下文
 * 持有独立的历史栈，支持嵌套切换和回退。
 */
export class DefaultSwitcher implements Switcher {
  private readonly logger = new Logger(DefaultSwitcher.name);
  private readonly storage = new AsyncLocalStorage<string[]>();
  private readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  private warnedOutsideRun = false;

  /**
   * 当前上下文的切换栈。
   *
   * 注意：栈属于最近一次 `run()`/`runAsync()` 创建的上下文，在其内部被所有异步分支共享。
   * 需要并行切换时（`Promise.all` 等），每个分支应各自包一层 `run()`。
   */
  private getStack(): string[] {
    const store = this.storage.getStore();
    if (store) return store;
    if (!this.warnedOutsideRun) {
      this.warnedOutsideRun = true;
      this.logger.warn(
        `${this.type} switcher used outside run()/runAsync(); the switch has no effect and the default ${this.type} is used`,
      );
    }
    return [];
  }

  useLast(): void {
    const stack = this.getStack();
    if (stack.length === 0) return;
    stack.pop();
    const current = this.current();
    this.logger.debug?.(
      current
        ? `try use last ${this.type}: ${current}`
        : `try use last default ${this.type}`,
    );
  }

  use(id: string): void {
    const stack = this.getStack();
    stack.push(id);
    this.logger.debug?.(`try use ${this.type}: ${id}`);
  }

  useDefault(): void {
    const stack = this.getStack();
    stack.push(DEFAULT_MARKER);
    this.logger.debug?.(`try use default ${this.type}`);
  }

  current(): string | undefined {
    const stack = this.getStack();
    if (stack.length === 0) return undefined;
    const last = stack[stack.length - 1];
    return last === DEFAULT_MARKER ? undefined : last;
  }

  reset(): void {
    const stack = this.getStack();
    stack.length = 0;
    this.logger.debug?.(`reset ${this.type} history`);
  }

  /**
   * 在隔离的切换上下文中执行函数
   */
  run<T>(fn: () => T): T {
    return this.storage.run([], fn);
  }

  /**
   * 在隔离的切换上下文中执行异步函数
   */
  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return this.storage.run([], fn);
  }
}

/**
 * DataSourceSwitcher — 对应 Java 端 JdbcSwitcher / R2dbcSwitcher
 *
 * 组合了数据源切换器和 schema 切换器，在一个请求上下文中
 * 可以同时切换数据源和 schema。
 */
export class DataSourceSwitcher {
  readonly datasource: DefaultSwitcher;
  readonly schema: DefaultSwitcher;
  readonly table: DefaultSwitcher;

  constructor() {
    this.datasource = new DefaultSwitcher('datasource');
    this.schema = new DefaultSwitcher('schema');
    this.table = new DefaultSwitcher('table');
  }

  /**
   * 在隔离的切换上下文中执行
   */
  run<T>(fn: () => T): T {
    return this.datasource.run(() =>
      this.schema.run(() =>
        this.table.run(fn),
      ),
    );
  }

  /**
   * 在隔离的切换上下文中执行异步函数
   */
  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return this.datasource.runAsync(() =>
      this.schema.runAsync(() =>
        this.table.runAsync(fn),
      ),
    );
  }

  /** 重置所有切换器 */
  resetAll(): void {
    this.datasource.reset();
    this.schema.reset();
    this.table.reset();
  }
}
