import { describe, it, expect } from 'vitest';
import { JsonSerializer, SerializerRegistry, SmartDateDeserializer } from './serializer';

describe('JsonSerializer', () => {
  const serializer = new JsonSerializer();

  it('should serialize and deserialize plain objects', () => {
    const obj = { name: 'Alice', age: 30 };
    const buf = serializer.serialize(obj);
    const result = serializer.deserialize(buf);
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('should serialize Date to ISO string and revive it', () => {
    const date = new Date('2024-06-15T10:30:00.000Z');
    const buf = serializer.serialize({ created: date });
    const result = serializer.deserialize<{ created: Date }>(buf);
    expect(result.created).toBeInstanceOf(Date);
    expect(result.created.getTime()).toBe(date.getTime());
  });

  it('should serialize bigint to string', () => {
    const obj = { id: 12345678901234567890n };
    const buf = serializer.serialize(obj);
    const parsed = JSON.parse(buf.toString());
    expect(parsed.id).toBe('12345678901234567890');
  });

  it('should handle arrays', () => {
    const arr = [1, 'two', { three: 3 }];
    const buf = serializer.serialize(arr);
    const result = serializer.deserialize(buf);
    expect(result).toEqual(arr);
  });

  it('should handle null values', () => {
    const obj = { value: null };
    const buf = serializer.serialize(obj);
    const result = serializer.deserialize(buf);
    expect(result).toEqual({ value: null });
  });

  it('should handle nested objects with dates', () => {
    const obj = {
      user: {
        name: 'Bob',
        loginAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    };
    const buf = serializer.serialize(obj);
    const result = serializer.deserialize<typeof obj>(buf);
    expect(result.user.loginAt).toBeInstanceOf(Date);
  });

  it('should not convert non-ISO date-like strings', () => {
    const obj = { text: 'hello world' };
    const buf = serializer.serialize(obj);
    const result = serializer.deserialize<typeof obj>(buf);
    expect(result.text).toBe('hello world');
  });

  it('should return correct content type', () => {
    expect(serializer.contentType()).toBe('application/json');
  });

  it('should handle empty object', () => {
    const buf = serializer.serialize({});
    expect(serializer.deserialize(buf)).toEqual({});
  });

  it('should handle boolean and number values', () => {
    const obj = { active: true, count: 0 };
    const buf = serializer.serialize(obj);
    const result = serializer.deserialize(buf);
    expect(result).toEqual({ active: true, count: 0 });
  });
});

describe('SerializerRegistry', () => {
  it('should have JSON serializer registered by default', () => {
    const registry = new SerializerRegistry();
    const s = registry.get('application/json');
    expect(s).toBeDefined();
    expect(s!.contentType()).toBe('application/json');
  });

  it('should return undefined for unregistered content type', () => {
    const registry = new SerializerRegistry();
    expect(registry.get('application/xml')).toBeUndefined();
  });

  it('should throw for unregistered content type with getOrThrow', () => {
    const registry = new SerializerRegistry();
    expect(() => registry.getOrThrow('text/xml')).toThrow('No serializer registered');
  });

  it('should return JSON serializer as default', () => {
    const registry = new SerializerRegistry();
    const def = registry.getDefault();
    expect(def.contentType()).toBe('application/json');
  });

  it('should register custom serializer', () => {
    const registry = new SerializerRegistry();
    const custom = {
      serialize: (obj: unknown) => Buffer.from(String(obj)),
      deserialize: <T>(data: Buffer) => data.toString() as T,
      contentType: () => 'text/plain',
    };
    registry.register(custom);
    expect(registry.get('text/plain')).toBe(custom);
  });
});

describe('SmartDateDeserializer', () => {
  it('should parse ISO 8601 string', () => {
    const result = SmartDateDeserializer.tryParse('2024-06-15T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-06-15T10:30:00.000Z');
  });

  it('should parse ISO string with timezone offset', () => {
    const result = SmartDateDeserializer.tryParse('2024-06-15T10:30:00+08:00');
    expect(result).toBeInstanceOf(Date);
  });

  it('should parse ISO string with milliseconds', () => {
    const result = SmartDateDeserializer.tryParse('2024-06-15T10:30:00.123Z');
    expect(result).toBeInstanceOf(Date);
  });

  it('should return undefined for non-date strings', () => {
    expect(SmartDateDeserializer.tryParse('hello')).toBeUndefined();
    expect(SmartDateDeserializer.tryParse('12345')).toBeUndefined();
    expect(SmartDateDeserializer.tryParse('')).toBeUndefined();
  });

  it('should parse millisecond timestamp via parse()', () => {
    const ts = 1718443800000; // some ms timestamp
    const result = SmartDateDeserializer.parse(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts);
  });

  it('should parse second-level timestamp via parse()', () => {
    const ts = 1718443800; // seconds
    const result = SmartDateDeserializer.parse(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts * 1000);
  });

  it('should parse numeric string as timestamp', () => {
    const result = SmartDateDeserializer.parse('1718443800000');
    expect(result).toBeInstanceOf(Date);
  });

  it('should parse date string', () => {
    const result = SmartDateDeserializer.parse('2024-06-15');
    expect(result).toBeInstanceOf(Date);
  });

  it('should throw on unparseable string', () => {
    expect(() => SmartDateDeserializer.parse('not-a-date')).toThrow('Cannot parse date');
  });
});
