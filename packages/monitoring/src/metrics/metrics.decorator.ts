import { MetricsRegistry, MetricLabels } from './metrics-registry';

export interface MetricsOptions {
  /** 可选的注入 registry 实例 */
  registry?: MetricsRegistry;
  /** 静态标签，附加到每个指标 */
  labels?: MetricLabels;
  /** 是否记录错误次数（默认 true） */
  trackErrors?: boolean;
  /** 是否记录活跃请求数（默认 false） */
  trackActiveRequests?: boolean;
}

/**
 * @Metrics 方法装饰器 — 自动记录调用次数、耗时、错误数
 *
 * @param name 指标名称前缀
 * @param options 可选配置
 */
export function Metrics(
  name: string,
  options?: MetricsOptions,
): MethodDecorator {
  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = function (this: { metricsRegistry?: MetricsRegistry }, ...args: unknown[]) {
      const registry: MetricsRegistry | undefined =
        options?.registry ?? this?.metricsRegistry;

      if (!registry) {
        return originalMethod.apply(this, args);
      }

      const baseLabels: MetricLabels = {
        method: String(propertyKey),
        class: this?.constructor?.name ?? 'Unknown',
        ...options?.labels,
      };

      const counter = registry.counter(`${name}_total`, `Total calls to ${String(propertyKey)}`);
      const timer = registry.timer(`${name}_duration_seconds`, `Duration of ${String(propertyKey)}`);
      const trackErrors = options?.trackErrors !== false;
      const trackActive = options?.trackActiveRequests === true;

      counter.increment(baseLabels);
      const stopTimer = timer.startTimer(baseLabels);

      let activeGauge: ReturnType<MetricsRegistry['gauge']> | undefined;
      if (trackActive) {
        activeGauge = registry.gauge(`${name}_active_requests`, `Active requests for ${String(propertyKey)}`);
        activeGauge.increment(baseLabels);
      }

      const onFinish = (isError: boolean) => {
        stopTimer();
        if (trackActive && activeGauge) {
          activeGauge.decrement(baseLabels);
        }
        if (isError && trackErrors) {
          const errorCounter = registry.counter(
            `${name}_errors_total`,
            `Error calls to ${String(propertyKey)}`,
          );
          errorCounter.increment(baseLabels);
        }
      };

      try {
        const result = originalMethod.apply(this, args);

        if (result && typeof result === 'object' && typeof result.then === 'function') {
          return result.then(
            (val: unknown) => {
              onFinish(false);
              return val;
            },
            (err: unknown) => {
              onFinish(true);
              throw err;
            },
          );
        }

        onFinish(false);
        return result;
      } catch (err) {
        onFinish(true);
        throw err;
      }
    };

    return descriptor;
  };
}
