import { describe, it, expect } from 'vitest';
import { ScriptUtils, scriptUtils } from './script-utils';

describe('ScriptUtils', () => {
  const utils = new ScriptUtils();

  it('now() 返回当前时间戳（数字）', () => {
    const before = Date.now();
    const ts = utils.now();
    const after = Date.now();
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('nowFormatted() 无参数返回 ISO 字符串', () => {
    const result = utils.nowFormatted();
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('nowFormatted(format) 按格式替换日期占位符', () => {
    const result = utils.nowFormatted('yyyy-MM-dd');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('newMap() 返回空对象', () => {
    const map = utils.newMap();
    expect(map).toEqual({});
    expect(typeof map).toBe('object');
  });

  it('newList() 返回空数组', () => {
    const list = utils.newList();
    expect(list).toEqual([]);
    expect(Array.isArray(list)).toBe(true);
  });

  it('toJsonString() 序列化为 JSON 字符串', () => {
    const result = utils.toJsonString({ a: 1, b: 'hello' });
    expect(result).toBe('{"a":1,"b":"hello"}');
  });

  it('parseJson() 解析 JSON 字符串', () => {
    const result = utils.parseJson('{"x":42}');
    expect(result).toEqual({ x: 42 });
  });

  it('toJavaType() 返回传入值（identity）', () => {
    const obj = { key: 'val' };
    expect(utils.toJavaType(obj)).toBe(obj);
    expect(utils.toJavaType(123)).toBe(123);
  });

  it('max() 求最大值', () => {
    expect(utils.max(1, 5, 3)).toBe(5);
  });

  it('max() 支持数组参数', () => {
    expect(utils.max([2, 8, 4])).toBe(8);
  });

  it('min() 求最小值', () => {
    expect(utils.min(3, 1, 4)).toBe(1);
  });

  it('min() 支持数组参数', () => {
    expect(utils.min([7, 2, 9])).toBe(2);
  });

  it('sha1Hex() 返回正确长度的十六进制摘要', () => {
    const result = utils.sha1Hex('hello');
    expect(typeof result).toBe('string');
    expect(result).toHaveLength(40);
  });

  it('sha1Hex(null) 返回 null', () => {
    // TypeScript type is string but runtime accepts null via JS interop
    expect(utils.sha1Hex(null as unknown as string)).toBeNull();
  });

  it('md5Hex() 返回正确长度的十六进制摘要', () => {
    const result = utils.md5Hex('hello');
    expect(typeof result).toBe('string');
    expect(result).toHaveLength(32);
  });

  it('md5Hex(null) 返回 null', () => {
    expect(utils.md5Hex(null as unknown as string)).toBeNull();
  });

  it('newByteArray() 返回指定大小的 Buffer', () => {
    const buf = utils.newByteArray(4);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(4);
  });

  it('newIntArray() 返回指定大小的 Int32Array', () => {
    const arr = utils.newIntArray(3);
    expect(arr).toBeInstanceOf(Int32Array);
    expect(arr.length).toBe(3);
  });

  it('newLongArray() 返回指定大小的 BigInt64Array', () => {
    const arr = utils.newLongArray(2);
    expect(arr).toBeInstanceOf(BigInt64Array);
    expect(arr.length).toBe(2);
  });

  it('scriptUtils 全局单例可直接使用', () => {
    expect(scriptUtils).toBeInstanceOf(ScriptUtils);
    expect(typeof scriptUtils.now()).toBe('number');
  });
});
