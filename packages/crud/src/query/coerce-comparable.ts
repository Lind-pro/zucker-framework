/** 纯日期（YYYY-MM-DD，无时间部分） */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** 带时间的 ISO-8601 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** 比较操作符的边界语义：起点吸附到当天 00:00，终点吸附到当天 23:59:59.999 */
export type ComparisonBoundary = 'start' | 'end';

/**
 * 比较类操作符（gt / gte / lt / lte / between）的取值归一化。
 *
 * 前端惯用 {"publicationDate$lte":"2026-12-31"} 这类 FilterMap 语法传筛选，
 * 字符串原样透传给 Prisma 的 DateTime 字段会被直接拒绝：
 *   Invalid value for argument `lte`: premature end of input. Expected ISO-8601 DateTime.
 *
 * 纯日期还必须按边界语义补齐时间，否则 lte "2026-12-31" 实际取到当天 00:00，
 * 会把结束日当天的数据整体漏掉（不报错，但结果静默错误）：
 *   - gte / lt  → 当天 00:00:00.000（含当天起点 / 不含当天）
 *   - lte / gt  → 当天 23:59:59.999（含当天全天 / 不含当天）
 *
 * 时区取运行进程的本地时区，由各应用自行通过 TZ 环境变量决定，框架不做假设。
 *
 * 非日期字符串（数值比较等）与非字符串值一律原样返回，不做任何转换。
 */
export function coerceComparable(value: unknown, boundary: ComparisonBoundary): unknown {
  if (typeof value !== 'string') return value;

  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    // 用分量构造而非 new Date(string)：后者对 "YYYY-MM-DD" 按 UTC 解析，
    // 会在非零时区下整体偏移一天。
    return boundary === 'start'
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);
  }

  if (ISO_DATETIME.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }

  return value;
}
