import { Injectable } from '@nestjs/common';

export interface MetricLabels {
  [key: string]: string;
}

function normalizeLabels(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(
    Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function serializeLabels(labels: MetricLabels): string {
  return JSON.stringify(normalizeLabels(labels));
}

function deserializeLabels(key: string): MetricLabels {
  if (!key) return {};
  return JSON.parse(key) as MetricLabels;
}

/**
 * 计数器 — 只增不减
 */
export class Counter {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly description: string,
  ) {}

  increment(labels: MetricLabels = {}, amount = 1): void {
    const key = this.labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  getAll(): Array<{ labels: MetricLabels; value: number }> {
    return Array.from(this.values.entries()).map(([key, value]) => ({
      labels: this.parseKey(key),
      value,
    }));
  }

  private labelsKey(labels: MetricLabels): string {
    return serializeLabels(labels);
  }

  private parseKey(key: string): MetricLabels {
    return deserializeLabels(key);
  }
}

/**
 * 仪表 — 可增可减
 */
export class Gauge {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly description: string,
  ) {}

  set(value: number, labels: MetricLabels = {}): void {
    this.values.set(this.labelsKey(labels), value);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsKey(labels)) ?? 0;
  }

  increment(labels: MetricLabels = {}, amount = 1): void {
    const key = this.labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  decrement(labels: MetricLabels = {}, amount = 1): void {
    const key = this.labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) - amount);
  }

  getAll(): Array<{ labels: MetricLabels; value: number }> {
    return Array.from(this.values.entries()).map(([key, value]) => ({
      labels: this.parseKey(key),
      value,
    }));
  }

  private labelsKey(labels: MetricLabels): string {
    return serializeLabels(labels);
  }

  private parseKey(key: string): MetricLabels {
    return deserializeLabels(key);
  }
}

/**
 * 直方图 — 观测值分布
 */
export class Histogram {
  private observations = new Map<string, number[]>();

  constructor(
    public readonly name: string,
    public readonly description: string,
    public readonly buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {}

  observe(value: number, labels: MetricLabels = {}): void {
    const key = this.labelsKey(labels);
    const arr = this.observations.get(key) ?? [];
    arr.push(value);
    this.observations.set(key, arr);
  }

  getPercentile(percentile: number, labels: MetricLabels = {}): number {
    const values = this.observations.get(this.labelsKey(labels)) ?? [];
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getCount(labels: MetricLabels = {}): number {
    return (this.observations.get(this.labelsKey(labels)) ?? []).length;
  }

  getSum(labels: MetricLabels = {}): number {
    return (this.observations.get(this.labelsKey(labels)) ?? []).reduce((a, b) => a + b, 0);
  }

  getAll(): Array<{ labels: MetricLabels; count: number; sum: number; bucketCounts: Record<string, number> }> {
    return Array.from(this.observations.entries()).map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const bucketCounts: Record<string, number> = {};
      for (const b of this.buckets) {
        bucketCounts[String(b)] = sorted.filter((v) => v <= b).length;
      }
      bucketCounts['+Inf'] = values.length;
      return {
        labels: this.parseKey(key),
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        bucketCounts,
      };
    });
  }

  private labelsKey(labels: MetricLabels): string {
    return serializeLabels(labels);
  }

  private parseKey(key: string): MetricLabels {
    return deserializeLabels(key);
  }
}

/**
 * 计时器 — 专门记录耗时
 */
export class Timer {
  private histogram: Histogram;

  constructor(
    public readonly name: string,
    public readonly description: string,
  ) {
    this.histogram = new Histogram(name, description);
  }

  /**
   * 记录一次耗时（秒）
   */
  record(durationSeconds: number, labels: MetricLabels = {}): void {
    this.histogram.observe(durationSeconds, labels);
  }

  /**
   * 开始计时，返回结束函数
   */
  startTimer(labels: MetricLabels = {}): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      this.record(duration, labels);
      return duration;
    };
  }

  getHistogram(): Histogram {
    return this.histogram;
  }
}

/**
 * Summary — 计算分位数（类似 Prometheus summary 类型）
 */
export class Summary {
  private observations = new Map<string, number[]>();
  private maxAge: number;

  constructor(
    public readonly name: string,
    public readonly description: string,
    public readonly quantiles: number[] = [0.5, 0.9, 0.95, 0.99],
    /** 观测值最大保留时间（毫秒），默认 10 分钟 */
    maxAgeMs = 600000,
  ) {
    this.maxAge = maxAgeMs;
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = this.labelsKey(labels);
    const arr = this.observations.get(key) ?? [];
    arr.push(value);
    // 限制内存：保留最近 10000 个观测值
    if (arr.length > 10000) {
      arr.splice(0, arr.length - 10000);
    }
    this.observations.set(key, arr);
  }

  getQuantile(quantile: number, labels: MetricLabels = {}): number {
    const values = this.observations.get(this.labelsKey(labels)) ?? [];
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(quantile * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getCount(labels: MetricLabels = {}): number {
    return (this.observations.get(this.labelsKey(labels)) ?? []).length;
  }

  getSum(labels: MetricLabels = {}): number {
    return (this.observations.get(this.labelsKey(labels)) ?? []).reduce((a, b) => a + b, 0);
  }

  getAll(): Array<{
    labels: MetricLabels;
    count: number;
    sum: number;
    quantileValues: Record<string, number>;
  }> {
    return Array.from(this.observations.entries()).map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const quantileValues: Record<string, number> = {};
      for (const q of this.quantiles) {
        const idx = Math.ceil(q * sorted.length) - 1;
        quantileValues[String(q)] = sorted[Math.max(0, idx)];
      }
      return {
        labels: this.parseKey(key),
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        quantileValues,
      };
    });
  }

  private labelsKey(labels: MetricLabels): string {
    return serializeLabels(labels);
  }

  private parseKey(key: string): MetricLabels {
    return deserializeLabels(key);
  }
}

/**
 * 指标注册中心
 */
@Injectable()
export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();
  private timers = new Map<string, Timer>();
  private summaries = new Map<string, Summary>();

  counter(name: string, description = ''): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, description);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, description = ''): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, description);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, description = '', buckets?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, description, buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  timer(name: string, description = ''): Timer {
    let t = this.timers.get(name);
    if (!t) {
      t = new Timer(name, description);
      this.timers.set(name, t);
    }
    return t;
  }

  summary(name: string, description = '', quantiles?: number[]): Summary {
    let s = this.summaries.get(name);
    if (!s) {
      s = new Summary(name, description, quantiles);
      this.summaries.set(name, s);
    }
    return s;
  }

  getCounters(): Counter[] {
    return Array.from(this.counters.values());
  }

  getGauges(): Gauge[] {
    return Array.from(this.gauges.values());
  }

  getHistograms(): Histogram[] {
    return Array.from(this.histograms.values());
  }

  getTimers(): Timer[] {
    return Array.from(this.timers.values());
  }

  getSummaries(): Summary[] {
    return Array.from(this.summaries.values());
  }

  /**
   * 重置所有指标
   */
  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.timers.clear();
    this.summaries.clear();
  }
}
