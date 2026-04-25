import { describe, it, expect } from 'vitest';
import { JsonCodec } from './codec';
import { Transports } from './transport';

describe('JsonCodec', () => {
  const codec = new JsonCodec<{ name: string; value: number }>('json-test', Transports.HTTP);

  it('should have correct id and transport', () => {
    expect(codec.id).toBe('json-test');
    expect(codec.transport).toBe(Transports.HTTP);
  });

  it('should encode object to JSON Buffer', () => {
    const encoded = codec.encode({ name: 'test', value: 42 });
    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(JSON.parse(encoded.toString('utf-8'))).toEqual({ name: 'test', value: 42 });
  });

  it('should decode JSON Buffer to object', () => {
    const buf = Buffer.from(JSON.stringify({ name: 'hello', value: 1 }));
    const decoded = codec.decode(buf);
    expect(decoded).toEqual({ name: 'hello', value: 1 });
  });

  it('should roundtrip encode/decode', () => {
    const original = { name: 'roundtrip', value: 99 };
    const encoded = codec.encode(original);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual(original);
  });

  it('should throw on invalid JSON decode', () => {
    const invalid = Buffer.from('not json');
    expect(() => codec.decode(invalid)).toThrow();
  });

  it('should handle null values', () => {
    const nullCodec = new JsonCodec<null>('null-codec', Transports.TCP);
    const encoded = nullCodec.encode(null);
    expect(nullCodec.decode(encoded)).toBeNull();
  });

  it('should handle arrays', () => {
    const arrayCodec = new JsonCodec<number[]>('array-codec', Transports.WS);
    const data = [1, 2, 3];
    const encoded = arrayCodec.encode(data);
    expect(arrayCodec.decode(encoded)).toEqual(data);
  });
});
