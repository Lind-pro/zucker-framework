import { describe, it, expect } from 'vitest';
import { coerceComparable } from './coerce-comparable';

/**
 * 比较操作符的日期归一化。
 *
 * 起因：下游项目按 {"publicationDate$lte":"2026-12-31"} 传筛选，字符串原样进
 * Prisma 的 DateTime 字段被拒（premature end of input）。某项目 30 天内因此
 * 产生 341 次 500，占其全部 500 错误的 64%。
 */
describe('coerceComparable', () => {
  describe('纯日期按边界语义补时间', () => {
    it('start 边界取当天 00:00:00.000', () => {
      const d = coerceComparable('2026-12-31', 'start') as Date;
      expect(d).toBeInstanceOf(Date);
      expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 31]);
      expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    });

    it('end 边界取当天 23:59:59.999', () => {
      const d = coerceComparable('2026-12-31', 'end') as Date;
      expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([23, 59, 59, 999]);
    });

    it('不因时区偏移到前后一天 —— new Date("YYYY-MM-DD") 按 UTC 解析会踩这个坑', () => {
      const d = coerceComparable('2026-01-01', 'start') as Date;
      expect(d.getDate()).toBe(1);
      expect(d.getMonth()).toBe(0);
      expect(d.getFullYear()).toBe(2026);
    });

    it('同一天的 start..end 覆盖整天，不是空区间', () => {
      const start = coerceComparable('2026-06-15', 'start') as Date;
      const end = coerceComparable('2026-06-15', 'end') as Date;
      expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000 - 1);
    });
  });

  describe('带时间的 ISO-8601 原值转 Date，不做边界吸附', () => {
    it('保留时分秒', () => {
      const d = coerceComparable('2026-12-31T10:30:00Z', 'end') as Date;
      expect(d).toBeInstanceOf(Date);
      expect(d.toISOString()).toBe('2026-12-31T10:30:00.000Z');
    });

    it('空格分隔的形式同样识别', () => {
      expect(coerceComparable('2026-12-31 10:30:00', 'start')).toBeInstanceOf(Date);
    });

    it('形似日期但非法的值原样返回，不产出 Invalid Date', () => {
      expect(coerceComparable('2026-13-45T99:99', 'start')).toBe('2026-13-45T99:99');
    });
  });

  describe('非日期值一律原样返回（比较操作符也用于数值）', () => {
    it.each([
      ['数字', 100],
      ['纯数字字符串', '100'],
      ['普通字符串', 'abc'],
      ['null', null],
      ['undefined', undefined],
      ['布尔', true],
    ])('%s 不变', (_label, value) => {
      expect(coerceComparable(value, 'start')).toBe(value);
    });

    it('Date 实例原样透传，不重复包装', () => {
      const d = new Date('2026-06-15T08:00:00Z');
      expect(coerceComparable(d, 'end')).toBe(d);
    });
  });
});
