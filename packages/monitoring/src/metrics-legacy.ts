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

export class InMemoryMetricsCollector implements MetricsCollector {
  private metrics: MetricPoint[] = [];

  private static sortedTagsKey(tags: Record<string, string>): string {
    const sortedKeys = Object.keys(tags).sort();
    const sorted: Record<string, string> = {};
    for (const k of sortedKeys) {
      sorted[k] = tags[k];
    }
    return JSON.stringify(sorted);
  }

  increment(name: string, tags: Record<string, string> = {}): void {
    const tagsKey = InMemoryMetricsCollector.sortedTagsKey(tags);
    const existing = this.metrics.find(
      (m) => m.name === name && InMemoryMetricsCollector.sortedTagsKey(m.tags) === tagsKey,
    );
    if (existing) {
      existing.value++;
      existing.timestamp = new Date();
    } else {
      this.metrics.push({ name, value: 1, tags, timestamp: new Date() });
    }
  }

  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    const tagsKey = InMemoryMetricsCollector.sortedTagsKey(tags);
    const existing = this.metrics.find(
      (m) => m.name === name && InMemoryMetricsCollector.sortedTagsKey(m.tags) === tagsKey,
    );
    if (existing) {
      existing.value = value;
      existing.timestamp = new Date();
    } else {
      this.metrics.push({ name, value, tags, timestamp: new Date() });
    }
  }

  histogram(name: string, value: number, tags: Record<string, string> = {}): void {
    this.metrics.push({ name, value, tags, timestamp: new Date() });
  }

  getMetrics(): MetricPoint[] {
    return [...this.metrics];
  }

  clear(): void {
    this.metrics = [];
  }
}
