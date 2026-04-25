import { describe, it, expect } from 'vitest';
import { generateId, generateUUID, generateSnowflakeId, createSnowflakeGenerator } from './index';

describe('generateId', () => {
  it('should return a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateUUID', () => {
  it('should return a valid UUID format', () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should generate unique UUIDs', () => {
    const uuids = new Set(Array.from({ length: 100 }, () => generateUUID()));
    expect(uuids.size).toBe(100);
  });
});

describe('generateSnowflakeId', () => {
  it('should return a numeric string', () => {
    const id = generateSnowflakeId();
    expect(typeof id).toBe('string');
    expect(Number.isFinite(Number(id))).toBe(true);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSnowflakeId()));
    expect(ids.size).toBe(100);
  });

  it('should generate monotonically increasing IDs', () => {
    const ids = Array.from({ length: 10 }, () => BigInt(generateSnowflakeId()));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThanOrEqual(ids[i - 1]);
    }
  });
});

describe('createSnowflakeGenerator', () => {
  it('should create a generator with custom workerId and dataCenterId', () => {
    const gen = createSnowflakeGenerator(1, 1);
    const id = gen();
    expect(typeof id).toBe('string');
    expect(Number.isFinite(Number(id))).toBe(true);
  });

  it('should throw for invalid workerId', () => {
    expect(() => createSnowflakeGenerator(32, 0)).toThrow('workerId must be between 0 and 31');
    expect(() => createSnowflakeGenerator(-1, 0)).toThrow('workerId must be between 0 and 31');
  });

  it('should throw for invalid dataCenterId', () => {
    expect(() => createSnowflakeGenerator(0, 32)).toThrow('dataCenterId must be between 0 and 31');
    expect(() => createSnowflakeGenerator(0, -1)).toThrow('dataCenterId must be between 0 and 31');
  });

  it('should generate unique IDs across different generators', () => {
    const gen1 = createSnowflakeGenerator(1, 0);
    const gen2 = createSnowflakeGenerator(2, 0);
    const id1 = gen1();
    const id2 = gen2();
    expect(id1).not.toBe(id2);
  });
});
