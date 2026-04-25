/**
 * 数据源切换策略 — 对应 Java 端 DataSourceSwitchStrategyMatcher / Strategy
 *
 * 定义切换策略的匹配逻辑和切换行为。
 */

/**
 * 切换策略结果
 */
export interface DataSourceSwitchStrategy {
  /** 是否使用默认数据源 */
  useDefaultDataSource: boolean;
  /** 数据源不存在时是否回退默认 */
  fallbackDefault: boolean;
  /** 要切换到的数据源 ID */
  dataSourceId?: string;
  /** 要切换到的数据库 / schema */
  database?: string;
}

/**
 * 策略匹配器接口 — 判断某个方法调用是否需要切换数据源
 */
export interface DataSourceSwitchStrategyMatcher {
  /**
   * 判断是否匹配（是否需要切换数据源）
   *
   * @param target 目标类名或标识
   * @param method 方法名
   */
  match(target: string, method: string): boolean;

  /**
   * 获取切换策略
   *
   * @param target 目标类名或标识
   * @param method 方法名
   * @param args   调用参数
   */
  getStrategy(
    target: string,
    method: string,
    args?: unknown[],
  ): DataSourceSwitchStrategy | undefined;
}

/**
 * 缓存策略匹配器 — 对应 Java 端 CachedDataSourceSwitchStrategyMatcher
 *
 * 首次匹配时调用 createStrategyIfMatch()，然后缓存结果。
 */
export abstract class CachedDataSourceSwitchStrategyMatcher
  implements DataSourceSwitchStrategyMatcher
{
  private readonly cache = new Map<string, DataSourceSwitchStrategy>();

  private cacheKey(target: string, method: string): string {
    return `${target}#${method}`;
  }

  abstract createStrategyIfMatch(
    target: string,
    method: string,
  ): DataSourceSwitchStrategy | undefined;

  match(target: string, method: string): boolean {
    const key = this.cacheKey(target, method);
    if (this.cache.has(key)) return true;

    const strategy = this.createStrategyIfMatch(target, method);
    if (strategy) {
      this.cache.set(key, strategy);
      return true;
    }
    return false;
  }

  getStrategy(
    target: string,
    method: string,
  ): DataSourceSwitchStrategy | undefined {
    return this.cache.get(this.cacheKey(target, method));
  }
}
