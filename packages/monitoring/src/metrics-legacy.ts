export interface MeasurementDefinition {
  id: string;
  name: string;
  dimensions: string[];
}

export interface MeasurementProvider {
  getDefinitions(): MeasurementDefinition[];
  getMeasurements(definitionId: string): Promise<Record<string, unknown>[]>;
}

export interface MetricPoint {
  name: string;
  value: number;
  tags: Record<string, string>;
  timestamp: Date;
}

export interface MetricsCollector {
  increment(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  getMetrics(): MetricPoint[];
}

/** Histogram points kept by InMemoryMetricsCollector (oldest dropped first). */
const MAX_HISTOGRAM_POINTS = 10_000;
/** Distinct counter/gauge series kept by InMemoryMetricsCollector; new series beyond it are dropped. */
const MAX_SERIES = 10_000;

export class InMemoryMetricsCollector implements MetricsCollector {
  private metrics: MetricPoint[] = [];
  /** Counter/gauge points by name + sorted tags (O(1) lookup instead of a scan per call). */
  private series = new Map<string, MetricPoint>();
  private histogramPoints = 0;

  private static sortedTagsKey(tags: Record<string, string>): string {
    const sortedKeys = Object.keys(tags).sort();
    const sorted: Record<string, string> = {};
    for (const k of sortedKeys) {
      sorted[k] = tags[k];
    }
    return JSON.stringify(sorted);
  }

  private static seriesKey(name: string, tags: Record<string, string>): string {
    return `${name}\u0000${InMemoryMetricsCollector.sortedTagsKey(tags)}`;
  }

  increment(name: string, tags: Record<string, string> = {}): void {
    const key = InMemoryMetricsCollector.seriesKey(name, tags);
    const existing = this.series.get(key);
    if (existing) {
      existing.value++;
      existing.timestamp = new Date();
    } else if (this.series.size < MAX_SERIES) {
      const point = { name, value: 1, tags, timestamp: new Date() };
      this.series.set(key, point);
      this.metrics.push(point);
    }
  }

  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    const key = InMemoryMetricsCollector.seriesKey(name, tags);
    const existing = this.series.get(key);
    if (existing) {
      existing.value = value;
      existing.timestamp = new Date();
    } else if (this.series.size < MAX_SERIES) {
      const point = { name, value, tags, timestamp: new Date() };
      this.series.set(key, point);
      this.metrics.push(point);
    }
  }

  histogram(name: string, value: number, tags: Record<string, string> = {}): void {
    this.metrics.push({ name, value, tags, timestamp: new Date() });
    this.histogramPoints += 1;
    // Trim in batches so the amortized cost per call stays O(1).
    if (this.histogramPoints > MAX_HISTOGRAM_POINTS + 1000) {
      let drop = this.histogramPoints - MAX_HISTOGRAM_POINTS;
      const series = new Set(this.series.values());
      this.metrics = this.metrics.filter((point) => {
        if (drop > 0 && !series.has(point)) {
          drop -= 1;
          return false;
        }
        return true;
      });
      this.histogramPoints = MAX_HISTOGRAM_POINTS;
    }
  }

  getMetrics(): MetricPoint[] {
    return [...this.metrics];
  }

  clear(): void {
    this.metrics = [];
    this.series.clear();
    this.histogramPoints = 0;
  }
}
