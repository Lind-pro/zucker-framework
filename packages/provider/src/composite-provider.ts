import { Logger } from '@nestjs/common';

/**
 * 组合 Provider — 按优先级聚合多个同类 Provider，
 * 参考 jetlinks CompositeNotifyConfigManager 的 switchIfEmpty 语义。
 */
export class CompositeProvider<T> {
  private readonly logger = new Logger(CompositeProvider.name);
  private readonly providers: T[] = [];

  constructor(providers?: T[]) {
    if (providers) {
      this.providers = [...providers];
    }
  }

  /**
   * 添加一个 provider（追加到末尾，优先级最低）
   */
  add(provider: T): void {
    this.providers.push(provider);
  }

  /**
   * 在指定位置插入 provider（索引越小优先级越高）
   */
  addFirst(provider: T): void {
    this.providers.unshift(provider);
  }

  /**
   * 按优先级依次尝试所有 provider，返回首个非空结果（switchIfEmpty 语义）
   */
  async get<R>(fn: (provider: T) => R | undefined | null | Promise<R | undefined | null>): Promise<R | undefined> {
    for (const provider of this.providers) {
      try {
        const result = await fn(provider);
        if (result !== undefined && result !== null) {
          return result;
        }
      } catch (err) {
        this.logger.debug(`Provider attempt failed, trying next: ${err}`);
      }
    }
    return undefined;
  }

  /**
   * 合并所有 provider 的结果并去重
   * @param fn 从每个 provider 获取数组结果
   * @param keyFn 可选的去重 key 提取函数
   */
  async getAll<R>(
    fn: (provider: T) => R[] | Promise<R[]>,
    keyFn?: (item: R) => string,
  ): Promise<R[]> {
    const allResults: R[] = [];
    const seenKeys = new Set<string>();

    for (const provider of this.providers) {
      try {
        const results = await fn(provider);
        for (const item of results) {
          if (keyFn) {
            const key = keyFn(item);
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              allResults.push(item);
            }
          } else {
            allResults.push(item);
          }
        }
      } catch (err) {
        this.logger.debug(`Provider getAll failed for one source: ${err}`);
      }
    }
    return allResults;
  }

  /**
   * 按优先级执行直到成功（switchIfEmpty 语义）
   * 如果某个 provider 抛错则跳过，尝试下一个
   */
  async execute<R>(fn: (provider: T) => Promise<R>): Promise<R> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      try {
        return await fn(provider);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.debug(`Provider execute failed, trying next: ${lastError.message}`);
      }
    }
    throw lastError ?? new Error('No providers available');
  }

  /**
   * 移除指定 provider
   * @returns true if the provider was found and removed
   */
  remove(provider: T): boolean {
    const idx = this.providers.indexOf(provider);
    if (idx >= 0) {
      this.providers.splice(idx, 1);
      return true;
    }
    return false;
  }

  getProviders(): readonly T[] {
    return this.providers;
  }

  get size(): number {
    return this.providers.length;
  }
}
