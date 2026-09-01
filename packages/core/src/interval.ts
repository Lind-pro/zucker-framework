/**
 * Interval — 时间间隔抽象
 * 参考: jetlinks Interval.java
 */

const UNIT_TO_MS: Record<string, number> = {
  S: 1,          // milliseconds
  s: 1000,       // seconds
  m: 60_000,     // minutes
  h: 3_600_000,  // hours
  d: 86_400_000, // days
  w: 604_800_000, // weeks
};

const INTERVAL_PATTERN = /^(-?[\d.]+)([SsmhdwMy])$/;

/**
 * Time interval abstraction supporting multiple units (ms, s, m, h, d, w, M, y).
 * Provides parsing, conversion, and iteration over time ranges.
 *
 * @example
 * ```ts
 * const interval = Interval.of('30m');
 * interval.toMilliseconds(); // 1800000
 * ```
 */
export class Interval {
  /** The numeric magnitude of the interval */
  readonly number: number;
  /** The unit character (S=ms, s=sec, m=min, h=hour, d=day, w=week, M=month, y=year) */
  readonly unit: string;

  constructor(number: number, unit: string) {
    this.number = number;
    this.unit = unit;
  }

  /**
   * 解析时间间隔字符串，如 "1h", "30m", "7d", "1w"
   */
  static of(expr: string): Interval {
    const match = INTERVAL_PATTERN.exec(expr.trim());
    if (!match) throw new Error(`Cannot parse interval expression: ${expr}`);
    return new Interval(parseFloat(match[1]), match[2]);
  }

  /**
   * Create an interval of the given number of seconds.
   * @param n - Number of seconds
   * @returns A new Interval instance
   */
  static ofSeconds(n: number): Interval {
    return new Interval(n, 's');
  }

  /**
   * Create an interval of the given number of minutes.
   * @param n - Number of minutes
   * @returns A new Interval instance
   */
  static ofMinutes(n: number): Interval {
    return new Interval(n, 'm');
  }

  /**
   * Create an interval of the given number of hours.
   * @param n - Number of hours
   * @returns A new Interval instance
   */
  static ofHours(n: number): Interval {
    return new Interval(n, 'h');
  }

  /**
   * Create an interval of the given number of days.
   * @param n - Number of days
   * @returns A new Interval instance
   */
  static ofDays(n: number): Interval {
    return new Interval(n, 'd');
  }

  /**
   * Convert the interval to milliseconds.
   * @returns Duration in milliseconds
   * @throws Error for unsupported units
   */
  toMilliseconds(): number {
    const unitMs = UNIT_TO_MS[this.unit];
    if (unitMs !== undefined) return this.number * unitMs;

    // Calendar-based units (approximate)
    if (this.unit === 'M') return this.number * 30 * 86_400_000;
    if (this.unit === 'y') return this.number * 365 * 86_400_000;

    throw new Error(`Unsupported interval unit: ${this.unit}`);
  }

  /**
   * Convert the interval to seconds.
   * @returns Duration in seconds
   */
  toSeconds(): number {
    return this.toMilliseconds() / 1000;
  }

  /**
   * Convert the interval to minutes.
   * @returns Duration in minutes
   */
  toMinutes(): number {
    return this.toMilliseconds() / 60_000;
  }

  /**
   * 按间隔遍历时间范围
   */
  iterate(start: Date, end: Date): Date[] {
    const stepMs = this.toMilliseconds();
    if (stepMs <= 0) throw new Error('Interval must be positive for iteration');

    const result: Date[] = [];
    let current = start.getTime();
    const endTime = end.getTime();

    while (current <= endTime) {
      result.push(new Date(current));
      current += stepMs;
    }

    return result;
  }

  toString(): string {
    return `${this.number}${this.unit}`;
  }
}
