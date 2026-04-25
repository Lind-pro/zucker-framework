/**
 * TimerSpec — 定时规格
 * 支持 cron 表达式、周期、一次性、时间窗口
 */

export type TimerType = 'cron' | 'interval' | 'once' | 'window';

export interface TimerSpecOptions {
  type: TimerType;
  /** cron 表达式 (type=cron 时使用) */
  cron?: string;
  /** 周期间隔毫秒 (type=interval 时使用) */
  intervalMs?: number;
  /** 一次性执行时间 (type=once 时使用) */
  executeAt?: Date;
  /** 时间窗口起止 (type=window 时使用) */
  windowStart?: string; // "HH:mm" format
  windowEnd?: string;   // "HH:mm" format
}

/**
 * 简化的 cron 字段解析（分 时 日 月 周）
 */
function parseCronField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  const values: number[] = [];
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const start = rangeStr === '*' ? min : parseInt(rangeStr, 10);
      for (let i = start; i <= max; i += step) values.push(i);
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return values.sort((a, b) => a - b);
}

export class TimerSpec {
  readonly type: TimerType;
  readonly cron?: string;
  readonly intervalMs?: number;
  readonly executeAt?: Date;
  readonly windowStart?: string;
  readonly windowEnd?: string;

  constructor(options: TimerSpecOptions) {
    this.type = options.type;
    this.cron = options.cron;
    this.intervalMs = options.intervalMs;
    this.executeAt = options.executeAt;
    this.windowStart = options.windowStart;
    this.windowEnd = options.windowEnd;
  }

  static cron(expression: string): TimerSpec {
    return new TimerSpec({ type: 'cron', cron: expression });
  }

  static interval(ms: number): TimerSpec {
    return new TimerSpec({ type: 'interval', intervalMs: ms });
  }

  static once(at: Date): TimerSpec {
    return new TimerSpec({ type: 'once', executeAt: at });
  }

  static window(start: string, end: string): TimerSpec {
    return new TimerSpec({ type: 'window', windowStart: start, windowEnd: end });
  }

  /**
   * 计算下次执行时间
   */
  nextExecutionTime(after: Date = new Date()): Date | null {
    switch (this.type) {
      case 'once':
        return this.executeAt && this.executeAt > after ? this.executeAt : null;

      case 'interval':
        if (!this.intervalMs) return null;
        return new Date(after.getTime() + this.intervalMs);

      case 'cron':
        return this.nextCronExecution(after);

      case 'window':
        return this.nextWindowStart(after);

      default:
        return null;
    }
  }

  /**
   * 检查指定时间是否命中
   */
  matches(date: Date): boolean {
    switch (this.type) {
      case 'once':
        return this.executeAt
          ? Math.abs(date.getTime() - this.executeAt.getTime()) < 1000
          : false;

      case 'interval':
        // Interval 没有固定的命中时间概念
        return false;

      case 'cron':
        return this.cronMatches(date);

      case 'window':
        return this.inWindow(date);

      default:
        return false;
    }
  }

  private nextCronExecution(after: Date): Date | null {
    if (!this.cron) return null;

    const parts = this.cron.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const minutes = parseCronField(parts[0], 0, 59);
    const hours = parseCronField(parts[1], 0, 23);
    const daysOfMonth = parseCronField(parts[2], 1, 31);
    const months = parseCronField(parts[3], 1, 12);
    const daysOfWeek = parseCronField(parts[4], 0, 6);

    // Search forward up to 366 days
    const candidate = new Date(after);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    for (let i = 0; i < 366 * 24 * 60; i++) {
      const m = candidate.getMinutes();
      const h = candidate.getHours();
      const dom = candidate.getDate();
      const mon = candidate.getMonth() + 1;
      const dow = candidate.getDay();

      if (
        minutes.includes(m) &&
        hours.includes(h) &&
        daysOfMonth.includes(dom) &&
        months.includes(mon) &&
        daysOfWeek.includes(dow)
      ) {
        return candidate;
      }

      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return null;
  }

  private cronMatches(date: Date): boolean {
    if (!this.cron) return false;

    const parts = this.cron.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const minutes = parseCronField(parts[0], 0, 59);
    const hours = parseCronField(parts[1], 0, 23);
    const daysOfMonth = parseCronField(parts[2], 1, 31);
    const months = parseCronField(parts[3], 1, 12);
    const daysOfWeek = parseCronField(parts[4], 0, 6);

    return (
      minutes.includes(date.getMinutes()) &&
      hours.includes(date.getHours()) &&
      daysOfMonth.includes(date.getDate()) &&
      months.includes(date.getMonth() + 1) &&
      daysOfWeek.includes(date.getDay())
    );
  }

  private inWindow(date: Date): boolean {
    if (!this.windowStart || !this.windowEnd) return false;

    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return timeStr >= this.windowStart && timeStr <= this.windowEnd;
  }

  private nextWindowStart(after: Date): Date | null {
    if (!this.windowStart) return null;

    const [h, m] = this.windowStart.split(':').map(Number);
    const candidate = new Date(after);
    candidate.setHours(h, m, 0, 0);

    if (candidate <= after) {
      candidate.setDate(candidate.getDate() + 1);
    }

    return candidate;
  }
}
