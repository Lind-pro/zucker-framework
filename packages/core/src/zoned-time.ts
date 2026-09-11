import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import localizedFormat from 'dayjs/plugin/localizedFormat.js';

// 扩展 dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(localizedFormat);

/**
 * 时间工具类，统一处理应用中的时间格式和时区问题
 */
export class ZonedTime {
  constructor(private readonly timezone: string) {}
  /**
   * 获取当前时间（本地时区）
   */
  now(): Date {
    return dayjs().tz(this.timezone).toDate();
  }

  /**
   * 格式化日期为字符串
   * @param date 日期对象或字符串
   * @param format 格式化模式，默认为 'YYYY-MM-DD HH:mm:ss'
   */
  format(date: Date | string, format: string = 'YYYY-MM-DD HH:mm:ss'): string {
    return dayjs(date).tz(this.timezone).format(format);
  }

  /**
   * 将UTC时间转换为本地时间
   * @param utcDate UTC日期对象或字符串
   */
  fromUTC(utcDate: Date | string): Date {
    return dayjs.utc(utcDate).tz(this.timezone).toDate();
  }

  /**
   * 获取当前日期字符串，格式为 YYYY-MM-DD
   */
  today(): string {
    return dayjs().tz(this.timezone).format('YYYY-MM-DD');
  }

  parse(dateString: string): Date {
    return dayjs(dateString).tz(this.timezone).toDate();
  }

  /**
   * 日期范围过滤的起点 —— 解析为当天 00:00:00.000。
   *
   * DTO 里的日期是 @IsDateString() 字符串（如 "2024-01-01"），直接喂给 Prisma 的
   * DateTime 字段会被拒：Invalid value for argument `gte`: premature end of input。
   */
  rangeStart(input: string | Date): Date {
    return dayjs(input).tz(this.timezone).startOf('day').toDate();
  }

  /**
   * 日期范围过滤的终点 —— 解析为当天 23:59:59.999。
   *
   * lte 做闭区间时必须取当天末尾：new Date("2024-12-31") 是当天 00:00，
   * 会把 12-31 全天的数据都排除在结果之外。
   */
  rangeEnd(input: string | Date): Date {
    return dayjs(input).tz(this.timezone).endOf('day').toDate();
  }
}
