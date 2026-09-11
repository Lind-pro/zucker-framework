import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
export interface DateTransformOptions {
  parse(value: string): Date;
  fromUTC(value: Date): Date;
}

/**
 * 日期转换管道
 * 用于将请求中的日期字符串转换为正确时区的Date对象
 */
@Injectable()
export class DateTransformPipe implements PipeTransform {
  constructor(private readonly options: DateTransformOptions) {}
  transform(value: unknown, metadata: ArgumentMetadata) {
    // 如果值不存在或元数据类型不是body，则直接返回原值
    if (value === undefined || metadata.type !== 'body') {
      return value;
    }

    // 处理对象中的所有属性
    return this.transformValue(value);
  }

  private transformValue(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // 如果是Date对象，确保使用正确的时区
    if (obj instanceof Date) {
      return this.options.fromUTC(obj);
    }

    // 如果是字符串，尝试解析为日期
    if (typeof obj === 'string' && this.isISODateString(obj)) {
      return this.options.parse(obj);
    }

    // 如果是数组，递归处理每个元素
    if (Array.isArray(obj)) {
      return obj.map((item) => this.transformValue(item));
    }

    // 如果是对象，递归处理每个属性
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          result[key] = this.transformValue((obj as Record<string, unknown>)[key]);
        }
      }
      return result;
    }

    // 其他类型直接返回
    return obj;
  }

  // 检查字符串是否是ISO日期格式
  private isISODateString(str: string): boolean {
    // ISO日期格式的正则表达式
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;
    return isoDatePattern.test(str) && !isNaN(Date.parse(str));
  }
}
