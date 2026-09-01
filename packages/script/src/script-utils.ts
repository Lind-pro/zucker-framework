import { createHash } from 'node:crypto';

/**
 * 脚本内置工具类 — 对齐 jetlinks AbstractScriptFactory.Utils
 * 在沙箱中以 `utils` 变量暴露给脚本使用
 */
export class ScriptUtils {
  /** 当前时间戳（毫秒） */
  now(): number {
    return Date.now();
  }

  /** 格式化当前时间 */
  nowFormatted(format?: string): string {
    const d = new Date();
    if (!format) return d.toISOString();
    // 简化格式化：yyyy-MM-dd HH:mm:ss
    return format
      .replace('yyyy', String(d.getFullYear()))
      .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
      .replace('dd', String(d.getDate()).padStart(2, '0'))
      .replace('HH', String(d.getHours()).padStart(2, '0'))
      .replace('mm', String(d.getMinutes()).padStart(2, '0'))
      .replace('ss', String(d.getSeconds()).padStart(2, '0'));
  }

  /** 创建新的 Map（对象） */
  newMap(): Record<string, unknown> {
    return {};
  }

  /** 创建新的数组 */
  newList(): unknown[] {
    return [];
  }

  /** 序列化为 JSON 字符串 */
  toJsonString(obj: unknown): string {
    return JSON.stringify(obj);
  }

  /** 解析 JSON 字符串 */
  parseJson(json: string): unknown {
    return JSON.parse(json);
  }

  /** 转换为 Java/原生类型（identity in JS） */
  toJavaType(obj: unknown): unknown {
    return obj;
  }

  /** 求最大值（支持数组、嵌套集合） */
  max(...params: unknown[]): unknown {
    let maxVal: unknown = undefined;
    for (let param of params) {
      if (param && typeof param === 'object' && !Array.isArray(param)) {
        param = Object.values(param as Record<string, unknown>);
      }
      if (Array.isArray(param)) {
        param = this.max(...param);
      }
      if (maxVal === undefined) {
        maxVal = param;
        continue;
      }
      if (Number(param) > Number(maxVal)) {
        maxVal = param;
      }
    }
    return maxVal;
  }

  /** 求最小值（支持数组、嵌套集合） */
  min(...params: unknown[]): unknown {
    let minVal: unknown = undefined;
    for (let param of params) {
      if (param && typeof param === 'object' && !Array.isArray(param)) {
        param = Object.values(param as Record<string, unknown>);
      }
      if (Array.isArray(param)) {
        param = this.min(...param);
      }
      if (minVal === undefined) {
        minVal = param;
        continue;
      }
      if (Number(param) < Number(minVal)) {
        minVal = param;
      }
    }
    return minVal;
  }

  /** SHA1 摘要（hex） */
  sha1Hex(str: string): string | null {
    if (str == null) return null;
    return createHash('sha1').update(str).digest('hex');
  }

  /** MD5 摘要（hex） */
  md5Hex(str: string): string | null {
    if (str == null) return null;
    return createHash('md5').update(str).digest('hex');
  }

  /** 创建指定大小的 Buffer */
  newByteArray(size: number): Buffer {
    return Buffer.alloc(size);
  }

  /** 创建指定大小的 Int32 数组 — 对齐 jetlinks Utils.newIntArray() */
  newIntArray(size: number): Int32Array {
    return new Int32Array(size);
  }

  /** 创建指定大小的 BigInt64 数组 — 对齐 jetlinks Utils.newLongArray() */
  newLongArray(size: number): BigInt64Array {
    return new BigInt64Array(size);
  }
}

/** 全局单例 */
export const scriptUtils = new ScriptUtils();
