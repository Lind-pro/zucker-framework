import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FieldTypeRegistry, FieldType, EnumFieldTypeProvider } from './field-type';
import type { FieldTypeProvider } from './field-type';

describe('FieldTypeRegistry', () => {
  it('should have built-in providers registered', () => {
    expect(FieldTypeRegistry.has(FieldType.STRING)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.NUMBER)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.BOOLEAN)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.DATE)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.DATETIME)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.JSON)).toBe(true);
    expect(FieldTypeRegistry.has(FieldType.ARRAY)).toBe(true);
  });

  it('should validate string type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.STRING)!;
    expect(provider.validate('hello')).toBeNull();
    expect(provider.validate(123)).toBe('Expected string');
  });

  it('should validate number type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.NUMBER)!;
    expect(provider.validate(42)).toBeNull();
    expect(provider.validate(NaN)).toBe('Expected number');
    expect(provider.validate('x')).toBe('Expected number');
  });

  it('should validate boolean type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.BOOLEAN)!;
    expect(provider.validate(true)).toBeNull();
    expect(provider.validate('true')).toBe('Expected boolean');
  });

  it('should validate date type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.DATE)!;
    expect(provider.validate(new Date())).toBeNull();
    expect(provider.validate('2024-01-01')).toBeNull();
    expect(provider.validate('not-a-date')).toBe('Expected date');
  });

  it('should validate JSON type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.JSON)!;
    expect(provider.validate({ a: 1 })).toBeNull();
    expect(provider.validate('string')).toBe('Expected object');
  });

  it('should validate array type correctly', () => {
    const provider = FieldTypeRegistry.get(FieldType.ARRAY)!;
    expect(provider.validate([1, 2])).toBeNull();
    expect(provider.validate('not array')).toBe('Expected array');
  });

  it('should deserialize number from string', () => {
    const provider = FieldTypeRegistry.get(FieldType.NUMBER)!;
    expect(provider.deserialize('3.14')).toBe(3.14);
  });

  it('should register and unregister custom providers', () => {
    const custom: FieldTypeProvider = {
      getType: () => 'custom',
      validate: () => null,
      serialize: (v) => v,
      deserialize: (v) => v,
    };
    FieldTypeRegistry.register(custom);
    expect(FieldTypeRegistry.has('custom')).toBe(true);
    FieldTypeRegistry.unregister('custom');
    expect(FieldTypeRegistry.has('custom')).toBe(false);
  });

  it('should list all providers via getAll()', () => {
    const all = FieldTypeRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('should create from spec using registered provider', () => {
    const enumProvider = new EnumFieldTypeProvider({
      options: [{ value: 'a', label: 'A' }],
    });
    FieldTypeRegistry.register(enumProvider);
    const created = FieldTypeRegistry.createFromSpec({
      name: FieldType.ENUM,
      configuration: {
        options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
        multiple: true,
      },
    });
    expect(created).toBeDefined();
    expect(created!.validate(['x'])).toBeNull();
    expect(created!.validate('x')).toBe('Expected array for multiple enum');
    FieldTypeRegistry.unregister(FieldType.ENUM);
  });

  it('get() returns undefined for unknown type', () => {
    expect(FieldTypeRegistry.get('__nonexistent__')).toBeUndefined();
  });

  it('register() overwrites existing provider with same type name', () => {
    const original = FieldTypeRegistry.get(FieldType.STRING)!;
    const override: FieldTypeProvider = {
      getType: () => FieldType.STRING,
      validate: () => 'always-error',
      serialize: (v) => v,
      deserialize: (v) => v,
    };
    FieldTypeRegistry.register(override);
    expect(FieldTypeRegistry.get(FieldType.STRING)!.validate('hello')).toBe('always-error');
    // Restore original
    FieldTypeRegistry.register(original);
    expect(FieldTypeRegistry.get(FieldType.STRING)!.validate('hello')).toBeNull();
  });

  it('getAll() includes a newly registered provider', () => {
    const extra: FieldTypeProvider = {
      getType: () => 'extra-test-type',
      validate: () => null,
      serialize: (v) => v,
      deserialize: (v) => v,
    };
    FieldTypeRegistry.register(extra);
    const all = FieldTypeRegistry.getAll();
    expect(all.some((p) => p.getType() === 'extra-test-type')).toBe(true);
    FieldTypeRegistry.unregister('extra-test-type');
  });

  it('createFromSpec() returns undefined for unregistered provider name', () => {
    const result = FieldTypeRegistry.createFromSpec({ name: '__no_such_type__' });
    expect(result).toBeUndefined();
  });

  it('should deserialize boolean from string "true"/"1"', () => {
    const provider = FieldTypeRegistry.get(FieldType.BOOLEAN)!;
    expect(provider.deserialize('true')).toBe(true);
    expect(provider.deserialize('1')).toBe(true);
    expect(provider.deserialize('false')).toBe(false);
  });

  it('should serialize and deserialize date values', () => {
    const provider = FieldTypeRegistry.get(FieldType.DATE)!;
    const d = new Date('2024-06-15');
    expect(provider.serialize(d)).toBe('2024-06-15');
    const back = provider.deserialize('2024-06-15');
    expect(back).toBeInstanceOf(Date);
  });

  it('should deserialize JSON from string', () => {
    const provider = FieldTypeRegistry.get(FieldType.JSON)!;
    const result = provider.deserialize('{"key":"val"}');
    expect(result).toEqual({ key: 'val' });
  });
});

describe('EnumFieldTypeProvider', () => {
  const provider = new EnumFieldTypeProvider({
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  });

  it('should validate valid single enum value', () => {
    expect(provider.validate('a')).toBeNull();
  });

  it('should reject invalid single enum value', () => {
    expect(provider.validate('z')).toContain('Invalid enum value');
  });

  it('should serialize single value as-is', () => {
    expect(provider.serialize('a')).toBe('a');
  });

  it('should return type and typeName', () => {
    expect(provider.getType()).toBe(FieldType.ENUM);
    expect(provider.getTypeName!()).toBe('Enum');
    expect(provider.getDefaultLength!()).toBe(64);
  });

  it('should validate multiple values when multiple=true', () => {
    const multi = new EnumFieldTypeProvider({
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      multiple: true,
    });
    expect(multi.validate(['a', 'b'])).toBeNull();
    expect(multi.validate(['a', 'z'])).toContain('Invalid enum value');
    expect(multi.validate('a')).toContain('Expected array');
  });

  it('should serialize multiple values with separator', () => {
    const multi = new EnumFieldTypeProvider({
      options: [{ value: 'a', label: 'A' }],
      multiple: true,
      separator: '|',
    });
    expect(multi.serialize(['a', 'b'])).toBe('a|b');
  });

  it('should deserialize multiple values from string', () => {
    const multi = new EnumFieldTypeProvider({
      options: [{ value: 'a', label: 'A' }],
      multiple: true,
      separator: '|',
    });
    expect(multi.deserialize('a|b')).toEqual(['a', 'b']);
  });

  it('getOptions() returns the configured options list', () => {
    const opts = provider['options'].options;
    expect(opts).toHaveLength(2);
    expect(opts[0].value).toBe('a');
    expect(opts[1].value).toBe('b');
  });

  it('createFromSpec() creates a new provider from spec configuration', () => {
    const spec = {
      name: FieldType.ENUM,
      configuration: {
        options: [{ value: 'x', label: 'X' }],
        multiple: false,
      },
    };
    const created = provider.createFromSpec(spec);
    expect(created.validate('x')).toBeNull();
    expect(created.validate('z')).toContain('Invalid enum value');
  });

  it('default separator is comma', () => {
    const multi = new EnumFieldTypeProvider({
      options: [{ value: '1', label: 'One' }, { value: '2', label: 'Two' }],
      multiple: true,
    });
    expect(multi.serialize(['1', '2'])).toBe('1,2');
    expect(multi.deserialize('1,2')).toEqual(['1', '2']);
  });
});
