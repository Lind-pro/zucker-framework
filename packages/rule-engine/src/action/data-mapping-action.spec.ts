import { describe, it, expect } from 'vitest';
import { DataMappingAction } from './data-mapping-action';
import type { DataMappingActionConfig } from './data-mapping-action';

describe('DataMappingAction', () => {
  const action = new DataMappingAction();

  it('should map source fields to target fields', () => {
    const config: DataMappingActionConfig = {
      mappings: [
        { target: 'output_name', source: 'name' },
        { target: 'output_age', source: 'age' },
      ],
    };
    const result = action.execute(config, { name: 'Alice', age: 30, extra: 'x' });
    expect(result).toEqual({ output_name: 'Alice', output_age: 30 });
  });

  it('should keep source data when keepSourceData is true', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'fullName', source: 'name' }],
      keepSourceData: true,
    };
    const result = action.execute(config, { name: 'Bob', age: 25 });
    expect(result).toEqual({ name: 'Bob', age: 25, fullName: 'Bob' });
  });

  it('should apply type conversion to string', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'out', source: 'num', type: 'string' }],
    };
    const result = action.execute(config, { num: 42 });
    expect(result.out).toBe('42');
  });

  it('should apply type conversion to number', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'out', source: 'str', type: 'number' }],
    };
    const result = action.execute(config, { str: '3.14' });
    expect(result.out).toBe(3.14);
  });

  it('should apply type conversion to integer (truncates)', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'out', source: 'val', type: 'integer' }],
    };
    const result = action.execute(config, { val: '7.9' });
    expect(result.out).toBe(7);
  });

  it('should apply type conversion to boolean', () => {
    const config: DataMappingActionConfig = {
      mappings: [
        { target: 'a', source: 'x', type: 'boolean' },
        { target: 'b', source: 'y', type: 'boolean' },
      ],
    };
    const result = action.execute(config, { x: 'true', y: '0' });
    expect(result.a).toBe(true);
    expect(result.b).toBe(false);
  });

  it('should support expression interpolation with ${field}', () => {
    const config: DataMappingActionConfig = {
      mappings: [
        { target: 'greeting', source: 'Hello ${name}, age ${age}' },
      ],
    };
    const result = action.execute(config, { name: 'Alice', age: 30 });
    expect(result.greeting).toBe('Hello Alice, age 30');
  });

  it('should support nested field access via dot notation', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'temp', source: 'device.temperature' }],
    };
    const result = action.execute(config, {
      device: { temperature: 36.5 },
    });
    expect(result.temp).toBe(36.5);
  });

  it('should skip mappings whose source resolves to null or undefined', () => {
    const config: DataMappingActionConfig = {
      mappings: [
        { target: 'a', source: 'existing' },
        { target: 'b', source: 'missing' },
      ],
    };
    const result = action.execute(config, { existing: 'yes' });
    expect(result).toEqual({ a: 'yes' });
    expect(result.b).toBeUndefined();
  });

  it('should apply type conversion to date', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'out', source: 'ts', type: 'date' }],
    };
    const result = action.execute(config, { ts: '2024-01-01T00:00:00Z' });
    expect(result.out).toBeInstanceOf(Date);
  });

  it('should return null for invalid date conversion', () => {
    const config: DataMappingActionConfig = {
      mappings: [{ target: 'out', source: 'ts', type: 'date' }],
    };
    const result = action.execute(config, { ts: 'not-a-date' });
    expect(result.out).toBeNull();
  });
});
