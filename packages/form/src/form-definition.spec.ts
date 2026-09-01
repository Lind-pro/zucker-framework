import { describe, it, expect } from 'vitest';
import { fromJsonSchema } from './form-definition';
import { FieldType } from './field-type';

describe('fromJsonSchema', () => {
  it('converts a simple string field', () => {
    const def = fromJsonSchema('f1', 'My Form', {
      properties: {
        username: { type: 'string' },
      },
    });
    expect(def.id).toBe('f1');
    expect(def.name).toBe('My Form');
    expect(def.fields).toHaveLength(1);
    expect(def.fields[0].key).toBe('username');
    expect(def.fields[0].type).toBe(FieldType.STRING);
  });

  it('converts a number field', () => {
    const def = fromJsonSchema('f2', 'F', {
      properties: { age: { type: 'number' } },
    });
    expect(def.fields[0].type).toBe(FieldType.NUMBER);
  });

  it('converts an integer field to NUMBER type', () => {
    const def = fromJsonSchema('f3', 'F', {
      properties: { count: { type: 'integer' } },
    });
    expect(def.fields[0].type).toBe(FieldType.NUMBER);
  });

  it('converts a boolean field', () => {
    const def = fromJsonSchema('f4', 'F', {
      properties: { active: { type: 'boolean' } },
    });
    expect(def.fields[0].type).toBe(FieldType.BOOLEAN);
  });

  it('converts an array field', () => {
    const def = fromJsonSchema('f5', 'F', {
      properties: { tags: { type: 'array' } },
    });
    expect(def.fields[0].type).toBe(FieldType.ARRAY);
  });

  it('converts an object field to JSON type', () => {
    const def = fromJsonSchema('f6', 'F', {
      properties: { meta: { type: 'object' } },
    });
    expect(def.fields[0].type).toBe(FieldType.JSON);
  });

  it('unknown type defaults to string', () => {
    const def = fromJsonSchema('f7', 'F', {
      properties: { whatever: { type: 'unknown-type' as any } },
    });
    expect(def.fields[0].type).toBe(FieldType.STRING);
  });

  it('string with format=date maps to DATE type', () => {
    const def = fromJsonSchema('f8', 'F', {
      properties: { dob: { type: 'string', format: 'date' } },
    });
    expect(def.fields[0].type).toBe(FieldType.DATE);
  });

  it('string with format=date-time maps to DATETIME type', () => {
    const def = fromJsonSchema('f9', 'F', {
      properties: { createdAt: { type: 'string', format: 'date-time' } },
    });
    expect(def.fields[0].type).toBe(FieldType.DATETIME);
  });

  it('string with enum maps to ENUM type and populates options', () => {
    const def = fromJsonSchema('f10', 'F', {
      properties: {
        status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
      },
    });
    const field = def.fields[0];
    expect(field.type).toBe(FieldType.ENUM);
    expect(field.options).toHaveLength(3);
    expect(field.options![0].value).toBe('active');
    expect(field.options![0].label).toBe('active');
    expect(field.options![2].value).toBe('pending');
  });

  it('required fields are marked as required=true', () => {
    const def = fromJsonSchema('f11', 'F', {
      properties: {
        name: { type: 'string' },
        opt: { type: 'string' },
      },
      required: ['name'],
    });
    const nameField = def.fields.find((f) => f.key === 'name')!;
    const optField = def.fields.find((f) => f.key === 'opt')!;
    expect(nameField.required).toBe(true);
    expect(optField.required).toBe(false);
  });

  it('title property maps to field name (label)', () => {
    const def = fromJsonSchema('f12', 'F', {
      properties: {
        firstName: { type: 'string', title: 'First Name' },
      },
    });
    expect(def.fields[0].name).toBe('First Name');
  });

  it('key is used as name when title is absent', () => {
    const def = fromJsonSchema('f13', 'F', {
      properties: {
        firstName: { type: 'string' },
      },
    });
    expect(def.fields[0].name).toBe('firstName');
  });

  it('description property maps to field description', () => {
    const def = fromJsonSchema('f14', 'F', {
      properties: {
        bio: { type: 'string', description: 'User biography' },
      },
    });
    expect(def.fields[0].description).toBe('User biography');
  });

  it('default value is preserved in field', () => {
    const def = fromJsonSchema('f15', 'F', {
      properties: {
        role: { type: 'string', default: 'user' },
      },
    });
    expect(def.fields[0].defaultValue).toBe('user');
  });

  it('array with items type populates elementType', () => {
    const def = fromJsonSchema('f16', 'F', {
      properties: {
        scores: { type: 'array', items: { type: 'number' } },
      },
    });
    expect(def.fields[0].elementType).toBe(FieldType.NUMBER);
  });

  it('array with boolean items populates elementType as BOOLEAN', () => {
    const def = fromJsonSchema('f17', 'F', {
      properties: {
        flags: { type: 'array', items: { type: 'boolean' } },
      },
    });
    expect(def.fields[0].elementType).toBe(FieldType.BOOLEAN);
  });

  it('array with string items populates elementType as STRING', () => {
    const def = fromJsonSchema('f18', 'F', {
      properties: {
        names: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(def.fields[0].elementType).toBe(FieldType.STRING);
  });

  it('multiple fields are all converted', () => {
    const def = fromJsonSchema('f19', 'Multi', {
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'boolean' },
      },
    });
    expect(def.fields).toHaveLength(3);
    const types = def.fields.map((f) => f.type);
    expect(types).toContain(FieldType.STRING);
    expect(types).toContain(FieldType.NUMBER);
    expect(types).toContain(FieldType.BOOLEAN);
  });

  it('empty schema produces empty fields list', () => {
    const def = fromJsonSchema('f20', 'Empty', {});
    expect(def.fields).toHaveLength(0);
  });
});
