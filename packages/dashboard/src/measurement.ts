/**
 * Base definition interface.
 *
 * Reference: jetlinks Definition
 */
export interface Definition {
  id: string;
  name: string;
}

export interface DimensionDefinition extends Definition {
  type?: string;
}

/**
 * Object definition — represents a dashboard object (e.g. CPU, Memory).
 *
 * Reference: jetlinks ObjectDefinition
 */
export interface ObjectDefinition extends Definition {}

export interface MeasurementDefinition extends Definition {
  dimensions: DimensionDefinition[];
}

/**
 * MeasurementParameter — typed parameter bag for dimension queries.
 *
 * Reference: jetlinks MeasurementParameter
 */
export class MeasurementParameter {
  readonly params: Record<string, unknown>;

  constructor(params: Record<string, unknown> = {}) {
    this.params = { ...params };
  }

  static of(params: Record<string, unknown>): MeasurementParameter {
    return new MeasurementParameter(params);
  }

  get<T = unknown>(name: string): T | undefined {
    return this.params[name] as T | undefined;
  }

  getString(name: string, defaultValue = ''): string {
    const val = this.params[name];
    return val !== undefined && val !== null ? String(val) : defaultValue;
  }

  getNumber(name: string, defaultValue = 0): number {
    const val = this.params[name];
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = Number(val);
      return isNaN(n) ? defaultValue : n;
    }
    return defaultValue;
  }

  values(): Record<string, unknown> {
    return { ...this.params };
  }
}

export interface MeasurementValue {
  value: number | unknown;
  timestamp?: Date;
  timeString?: string;
  tags?: Record<string, string>;
}

/**
 * SimpleMeasurementValue — concrete measurement value with time formatting and sorting.
 *
 * Reference: jetlinks SimpleMeasurementValue
 */
export class SimpleMeasurementValue implements MeasurementValue {
  value: number | unknown;
  timeString: string;
  timestamp: Date;
  tags?: Record<string, string>;

  constructor(value: number | unknown, timestamp: Date, tags?: Record<string, string>) {
    this.value = value;
    this.timestamp = timestamp;
    this.timeString = SimpleMeasurementValue.formatTime(timestamp);
    this.tags = tags;
  }

  static of(value: number | unknown, timestamp?: Date | number): SimpleMeasurementValue {
    const ts = timestamp instanceof Date
      ? timestamp
      : typeof timestamp === 'number'
        ? new Date(timestamp)
        : new Date();
    return new SimpleMeasurementValue(value, ts);
  }

  private static formatTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Compare by timestamp ascending.
   */
  static compareAsc(a: MeasurementValue, b: MeasurementValue): number {
    const ta = a.timestamp?.getTime() ?? 0;
    const tb = b.timestamp?.getTime() ?? 0;
    return ta - tb;
  }

  /**
   * Compare by timestamp descending (newest first, default sort).
   */
  static compareDesc(a: MeasurementValue, b: MeasurementValue): number {
    const ta = a.timestamp?.getTime() ?? 0;
    const tb = b.timestamp?.getTime() ?? 0;
    return tb - ta;
  }
}

export interface MeasurementDimension {
  definition: DimensionDefinition;
  /** Whether this dimension provides real-time data */
  isRealTime?(): boolean;
  /** Get parameter metadata for this dimension */
  getParams?(): Record<string, unknown>;
  getValue(params?: MeasurementParameter | Record<string, unknown>): Promise<MeasurementValue>;
}

/**
 * Measurement — a metric with multiple dimensions.
 *
 * Reference: jetlinks Measurement
 */
export interface Measurement {
  definition: MeasurementDefinition;
  getDimensions(): MeasurementDimension[];
  getDimension(id: string): MeasurementDimension | undefined;
}

/**
 * DashboardObject — groups measurements under a named object (e.g. CPU, Memory).
 *
 * Reference: jetlinks DashboardObject
 */
export interface DashboardObject {
  definition: ObjectDefinition;
  getMeasurements(): Measurement[];
  getMeasurement(id: string): Measurement | undefined;
}

/**
 * Dashboard — top-level container with objects.
 *
 * Reference: jetlinks Dashboard
 */
export interface Dashboard {
  definition: Definition;
  getObjects(): DashboardObject[];
  getObject(id: string): DashboardObject | undefined;
}

/**
 * MeasurementProvider SPI — pluggable measurement source.
 *
 * Reference: jetlinks supports.MeasurementProvider
 */
export interface MeasurementProvider {
  /** Dashboard definition this provider belongs to */
  getDashboardDefinition(): Definition;
  /** Object definition this provider belongs to */
  getObjectDefinition(): ObjectDefinition;
  /** Get all measurements from this provider */
  getMeasurements(): Measurement[];
  /** Get a specific measurement by id */
  getMeasurement(id: string): Measurement | undefined;
}
