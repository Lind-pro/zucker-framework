import { TimeSeriesMetadata } from './timeseries-metadata';
import { TimeSeriesService } from './timeseries-service';

/**
 * 时序数据管理器接口 — 注册指标元数据并获取对应的 TimeSeriesService
 * 对应 jetlinks TimeSeriesManager
 */
export interface TimeSeriesManager {
  /**
   * 注册指标元数据 — 对应 jetlinks TimeSeriesManager.registerMetadata()
   *
   * Java 版返回 Mono<Void>（异步），这里保持 Promise<void> | void 兼容。
   * 实现可根据需要选择同步或异步注册。
   */
  registerMetric(metadata: TimeSeriesMetadata): void | Promise<void>;

  /** 注销指标元数据 */
  unregisterMetric?(metric: string): boolean;

  /** 获取指标元数据 */
  getMetadata(metric: string): TimeSeriesMetadata | undefined;

  /** 获取所有已注册的指标 */
  getAllMetrics(): TimeSeriesMetadata[];

  /** 获取指定指标的数据服务 — 对应 jetlinks getService(String) / getService(TimeSeriesMetric) */
  getService(metric: string): TimeSeriesService;

  /**
   * 获取多个指标的合并数据服务 — 对应 jetlinks getServices(TimeSeriesMetric...) / getServices(String...)
   * 返回一个可以跨多个指标查询的 TimeSeriesService
   */
  getServices?(metrics: string[]): TimeSeriesService;
}
